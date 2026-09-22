#!/usr/bin/env node

const baseUrl = requiredEnv('BASE_URL').replace(/\/$/, '');
const accessToken = requiredEnv('MCP_ACCESS_TOKEN');
const expectedStoreId = process.env.MCP_EXPECT_STORE_ID?.trim() || null;
const timeoutMs = numberEnv('MCP_SMOKE_TIMEOUT_MS', 15000);
const protocolVersion = '2026-07-28';
const clientInfo = { name: 'stride-release-smoke', version: '1.0.0' };
const clientCapabilities = {};
const results = [];
let nextId = 1;

const metadata = await httpCheck('Protected resource metadata', '/.well-known/oauth-protected-resource/mcp', {
  auth: false,
});
assert(metadata.body?.resource === `${baseUrl}/mcp`, `Protected resource mismatch: ${String(metadata.body?.resource)}`);
assert(
  Array.isArray(metadata.body?.authorization_servers) && metadata.body.authorization_servers.length > 0,
  'Protected resource metadata is missing authorization_servers',
);

const authorizationServer = await httpCheck(
  'OAuth authorization-server metadata',
  '/.well-known/oauth-authorization-server',
  { auth: false },
);
assert(
  authorizationServer.body?.authorization_response_iss_parameter_supported === true,
  'OAuth metadata does not advertise issuer-bound authorization responses',
);
assert(
  authorizationServer.body?.client_id_metadata_document_supported === true,
  'OAuth metadata does not advertise CIMD support',
);
assert(
  Array.isArray(authorizationServer.body?.code_challenge_methods_supported) &&
    authorizationServer.body.code_challenge_methods_supported.includes('S256'),
  'OAuth metadata does not advertise PKCE S256',
);

const unauthenticated = await rawMcp('Unauthenticated MCP challenge', 'tools/list', {}, {
  auth: false,
  expectedStatus: 401,
});
assert(
  typeof unauthenticated.response.headers.get('www-authenticate') === 'string',
  'Unauthenticated MCP response is missing WWW-Authenticate',
);
assert(
  unauthenticated.response.headers.get('cache-control')?.includes('no-store') === true,
  'Unauthenticated MCP response is cacheable',
);

const discovery = await mcpCall('MCP server discovery', 'server/discover', {});
assert(
  Array.isArray(discovery.result?.supportedVersions) &&
    discovery.result.supportedVersions.includes(protocolVersion),
  `MCP server does not advertise ${protocolVersion}`,
);
assert(discovery.result?.resultType === 'complete', 'Discovery result is not complete');
assert(
  discovery.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name === 'Stride',
  'Discovery response is missing Stride server identity',
);

const toolList = await mcpCall('MCP tool catalog', 'tools/list', {});
const toolDescriptors = Array.isArray(toolList.result?.tools) ? toolList.result.tools : [];
const toolNames = toolDescriptors.map((tool) => tool?.name).filter(Boolean);
const requiredTools = [
  'stride_get_context',
  'stride_get_snapshot',
  'stride_search',
  'stride_get_commerce',
  'stride_get_paid_media',
  'stride_get_storefront',
  'stride_get_attribution',
  'stride_get_product_ads',
  'stride_get_recommendations',
  'stride_get_decision_settings',
  'stride_get_report',
];
for (const tool of requiredTools) {
  assert(toolNames.includes(tool), `MCP tool catalog is missing ${tool}`);
  const descriptor = toolDescriptors.find((candidate) => candidate?.name === tool);
  const oauthScheme = descriptor?.securitySchemes?.find((scheme) => scheme?.type === 'oauth2');
  assert(oauthScheme?.scopes?.includes('mcp:read'), `${tool} is missing the standard mcp:read OAuth security scheme`);
  const compatibilityScheme = descriptor?._meta?.securitySchemes?.find((scheme) => scheme?.type === 'oauth2');
  assert(
    compatibilityScheme?.scopes?.includes('mcp:read'),
    `${tool} is missing the compatibility OAuth security-scheme mirror`,
  );
}

const contextCall = await mcpCall('MCP store context', 'tools/call', {
  name: 'stride_get_context',
  arguments: {},
});
const context = toolData(contextCall);
assert(typeof context?.store?.id === 'string', 'MCP context is missing store.id');
if (expectedStoreId) {
  assert(context.store.id === expectedStoreId, `Expected store ${expectedStoreId}, received ${context.store.id}`);
}
assert(context?.knowledge?.readOnly === true, 'MCP knowledge catalog is not marked read-only');

const snapshotCall = await mcpCall('MCP advisor snapshot', 'tools/call', {
  name: 'stride_get_snapshot',
  arguments: { days: 30, fresh: false },
});
const snapshot = toolData(snapshotCall);
assert(snapshot?.context?.store?.id === context.store.id, 'Snapshot store does not match OAuth-bound context store');
assert(!Object.prototype.hasOwnProperty.call(snapshot?.dashboardSections ?? {}, 'recentOrders'), 'Snapshot leaked recentOrders');
if (snapshot?.intelligence?.available) {
  assert(
    Array.isArray(snapshot.intelligence.data?.recommendations),
    'Snapshot intelligence is missing recommendations[]',
  );
  for (const recommendation of snapshot.intelligence.data.recommendations) {
    assert(
      typeof recommendation?.lifecycleState === 'string',
      'Snapshot recommendation is missing lifecycleState',
    );
  }
}

const recommendationsCall = await mcpCall('MCP recommendations', 'tools/call', {
  name: 'stride_get_recommendations',
  arguments: { fresh: false },
});
const recommendations = toolData(recommendationsCall);
assert(Array.isArray(recommendations?.recommendations), 'Recommendation read is missing recommendations[]');
for (const recommendation of recommendations.recommendations) {
  assert(typeof recommendation?.lifecycleState === 'string', 'Recommendation is missing lifecycleState');
}

const contextResource = await mcpCall('MCP private context resource', 'resources/read', {
  uri: 'stride://store/context',
});
assert(contextResource.result?.cacheScope === 'private', 'Store resource is not marked private');
assert(contextResource.result?.ttlMs === 0, 'Store resource unexpectedly advertises a cache TTL');
const resourceData = resourceJson(contextResource);
assert(resourceData?.store?.id === context.store.id, 'Context resource store differs from tool context');

printSummary({ storeId: context.store.id, toolCount: toolNames.length });

async function mcpCall(name, method, params) {
  const id = nextId++;
  const requestParams = {
    ...params,
    _meta: {
      ...(params?._meta ?? {}),
      'io.modelcontextprotocol/protocolVersion': protocolVersion,
      'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
      'io.modelcontextprotocol/clientInfo': clientInfo,
    },
  };
  const principal = method === 'tools/call' ? params?.name : method === 'resources/read' ? params?.uri : null;
  const response = await rawMcp(name, method, requestParams, { id, principal, auth: true, expectedStatus: 200 });
  const body = response.body;
  assert(body?.jsonrpc === '2.0', `${name} did not return JSON-RPC 2.0`);
  assert(body?.id === id, `${name} returned the wrong JSON-RPC id`);
  assert(!body?.error, `${name} returned MCP error: ${compactBody(body?.error)}`);
  return body;
}

async function rawMcp(name, method, params, options = {}) {
  const id = options.id ?? nextId++;
  const requestParams = options.auth === false
    ? {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocolVersion,
          'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
          'io.modelcontextprotocol/clientInfo': clientInfo,
        },
      }
    : params;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': method,
    ...(options.principal ? { 'Mcp-Name': options.principal } : {}),
    ...(options.auth === false ? {} : { Authorization: `Bearer ${accessToken}` }),
  };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: requestParams }),
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseBody(text);
    const durationMs = Date.now() - startedAt;
    const expectedStatus = options.expectedStatus ?? 200;
    if (response.status !== expectedStatus) {
      throw new Error(`${name} expected HTTP ${expectedStatus}, received ${response.status}: ${compactBody(body)}`);
    }
    results.push({ name, ok: true, status: response.status, durationMs });
    console.log(`PASS ${name} (${response.status}, ${durationMs} ms)`);
    return { response, body, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    results.push({ name, ok: false, durationMs, error: error instanceof Error ? error.message : String(error) });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function httpCheck(name, path, options = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.auth === false ? {} : { Authorization: `Bearer ${accessToken}` }),
      },
    });
    const body = parseBody(await response.text());
    const durationMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}: ${compactBody(body)}`);
    results.push({ name, ok: true, status: response.status, durationMs });
    console.log(`PASS ${name} (${response.status}, ${durationMs} ms)`);
    return { response, body, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    results.push({ name, ok: false, durationMs, error: error instanceof Error ? error.message : String(error) });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toolData(body) {
  assert(body?.result?.isError === false, `MCP tool returned isError=true: ${compactBody(body?.result)}`);
  return body?.result?.structuredContent?.data;
}

function resourceJson(body) {
  const text = body?.result?.contents?.[0]?.text;
  assert(typeof text === 'string', 'MCP resource is missing JSON text content');
  return parseBody(text);
}

function printSummary(context) {
  console.log('\nStride MCP release smoke summary');
  console.table(
    results.map((item) => ({
      check: item.name,
      result: item.ok ? 'PASS' : 'FAIL',
      http: item.status ?? '',
      ms: item.durationMs ?? '',
      note: item.error ?? '',
    })),
  );
  console.log('Release evidence:');
  console.log(`- OAuth-bound store: ${context.storeId}`);
  console.log(`- Advertised read-only tools: ${context.toolCount}`);
  console.log(`- Protocol revision: ${protocolVersion}`);
  console.log('- Unauthenticated challenge: verified');
  console.log('- External-client OAuth/CIMD metadata: verified');
  console.log('- Per-tool OAuth security schemes: verified');
  console.log('- Snapshot privacy/lifecycle checks: verified');
  console.log('- Private resource cache policy: verified');
  console.log('\nThis smoke test assumes MCP_ACCESS_TOKEN was obtained through the real OAuth flow.');
  console.log('Run each external client authorization flow separately to validate consent and callback UX end to end.');
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compactBody(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
