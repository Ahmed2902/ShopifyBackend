import { ZodError } from 'zod';
import { advisorReadService, type AdvisorReadService } from '../business-knowledge/advisor-read.service.js';
import { MCP_TOOLS, mcpToolExecutor, type McpToolExecutor } from './mcp-tools.js';

export const MCP_MODERN_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSION = '2025-11-25';
const SERVER_NAME = 'Stride';
const SERVER_VERSION = '1.0.0';
const SERVER_META = {
  'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
};
const INSTRUCTIONS =
  'You are connected to Stride, a read-only marketing intelligence system. Start broad with stride_get_snapshot, then drill into commerce, paid media, storefront, attribution, Product × Ads, or deterministic recommendations. Shopify is commerce truth; provider attribution and first-party Pixel evidence must remain explicitly distinguished. Never invent missing data or claim Stride executed an action.';

export type JsonRpcId = string | number | null;
export type McpRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type McpHeaders = {
  protocolVersion?: string;
  method?: string;
  name?: string;
};

type RpcError = { code: number; message: string; data?: unknown };

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: JsonRpcId, error: RpcError) {
  return { jsonrpc: '2.0' as const, id, error };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function principalName(method: string, params: Record<string, unknown>) {
  if (method === 'tools/call') return typeof params.name === 'string' ? params.name : undefined;
  if (method === 'resources/read') return typeof params.uri === 'string' ? params.uri : undefined;
  return undefined;
}

function clientProtocolVersion(params: Record<string, unknown>) {
  const meta = asRecord(params._meta);
  const value = meta['io.modelcontextprotocol/protocolVersion'];
  return typeof value === 'string' ? value : undefined;
}

function completeResult(result: Record<string, unknown>, modern: boolean) {
  if (!modern) return result;
  return { resultType: 'complete', ...result, _meta: { ...SERVER_META, ...asRecord(result._meta) } };
}

function toolPayload(data: unknown, modern: boolean) {
  const structuredContent = { data };
  return completeResult(
    {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent,
      isError: false,
    },
    modern,
  );
}

function toolError(message: string, modern: boolean) {
  return completeResult(
    {
      content: [{ type: 'text', text: message }],
      structuredContent: { data: { error: message } },
      isError: true,
    },
    modern,
  );
}

function resource(uri: string, name: string, description: string) {
  return { uri, name, description, mimeType: 'application/json' };
}

const RESOURCES = [
  resource(
    'stride://knowledge/catalog',
    'Stride knowledge catalog',
    'Everything Stride can understand, its source-of-truth boundaries, caveats and provider capabilities.',
  ),
  resource(
    'stride://store/context',
    'Current Stride store context',
    'Merchant/store identity, currencies, timezone, domains, integrations and freshness for the OAuth-bound store.',
  ),
  resource(
    'stride://store/snapshot',
    'Current Stride advisor snapshot',
    'Compact 30-day cross-domain advisor context for the OAuth-bound store.',
  ),
] as const;

/** Protocol-only layer. It has no repository/Prisma/provider access. */
export class McpProtocolService {
  constructor(
    private readonly reads: AdvisorReadService = advisorReadService,
    private readonly tools: McpToolExecutor = mcpToolExecutor,
  ) {}

  async handle(storeId: string, request: McpRpcRequest, headers: McpHeaders) {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { status: 400, body: rpcError(request.id ?? null, { code: -32600, message: 'Invalid Request' }) };
    }

    const modern = headers.protocolVersion === MCP_MODERN_VERSION || request.method === 'server/discover';
    if (modern) {
      const validationError = this.validateModernEnvelope(request, headers);
      if (validationError) return { status: 400, body: rpcError(request.id ?? null, validationError) };
    } else if (headers.protocolVersion && headers.protocolVersion !== MCP_LEGACY_VERSION) {
      return {
        status: 400,
        body: rpcError(request.id ?? null, {
          code: -32600,
          message: `Unsupported MCP protocol version: ${headers.protocolVersion}`,
        }),
      };
    }

    if (request.id === undefined) {
      // Legacy initialized/cancel notifications are acknowledged without a JSON-RPC response.
      return { status: 202, body: null };
    }

    try {
      const result = await this.dispatch(storeId, request, modern);
      return { status: 200, body: rpcResult(request.id, result) };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          status: 200,
          body: rpcError(request.id, {
            code: -32602,
            message: 'Invalid params',
            data: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          }),
        };
      }
      const message = error instanceof Error ? error.message : 'Stride MCP tool failed';
      if (request.method === 'tools/call') {
        return { status: 200, body: rpcResult(request.id, toolError(message, modern)) };
      }
      return { status: 200, body: rpcError(request.id, { code: -32603, message: message.slice(0, 1000) }) };
    }
  }

  private validateModernEnvelope(request: McpRpcRequest, headers: McpHeaders): RpcError | null {
    if (headers.protocolVersion !== MCP_MODERN_VERSION) {
      return { code: -32020, message: `MCP-Protocol-Version must be ${MCP_MODERN_VERSION}` };
    }
    if (headers.method !== request.method) {
      return { code: -32020, message: 'Mcp-Method header does not match JSON-RPC method' };
    }
    const params = asRecord(request.params);
    const bodyVersion = clientProtocolVersion(params);
    if (bodyVersion && bodyVersion !== headers.protocolVersion) {
      return { code: -32020, message: 'Protocol version header/body mismatch' };
    }
    const expectedName = principalName(request.method, params);
    if (expectedName && headers.name !== expectedName) {
      return { code: -32020, message: 'Mcp-Name header does not match request principal' };
    }
    if (!expectedName && headers.name) {
      return { code: -32020, message: 'Mcp-Name is not valid for this request' };
    }
    return null;
  }

  private async dispatch(storeId: string, request: McpRpcRequest, modern: boolean) {
    const params = asRecord(request.params);
    switch (request.method) {
      case 'server/discover':
        if (!modern) throw new Error('server/discover requires modern MCP');
        return completeResult(
          {
            supportedVersions: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION],
            capabilities: { tools: {}, resources: {} },
            instructions: INSTRUCTIONS,
            ttlMs: 3_600_000,
            cacheScope: 'public',
          },
          true,
        );
      case 'initialize':
        return {
          protocolVersion: MCP_LEGACY_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        };
      case 'ping':
        if (modern) throw new Error('ping is not defined by modern MCP');
        return {};
      case 'tools/list':
        return completeResult(
          {
            tools: MCP_TOOLS,
            ...(modern ? { ttlMs: 3_600_000, cacheScope: 'public' } : {}),
          },
          modern,
        );
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name) throw new ZodError([]);
        const data = await this.tools.call(storeId, name, params.arguments);
        return toolPayload(data, modern);
      }
      case 'resources/list':
        return completeResult(
          {
            resources: RESOURCES,
            ...(modern ? { ttlMs: 3_600_000, cacheScope: 'public' } : {}),
          },
          modern,
        );
      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        if (!uri) throw new Error('uri is required');
        const data = await this.readResource(storeId, uri);
        return completeResult(
          {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(data),
              },
            ],
            ...(modern
              ? {
                  ttlMs: uri === 'stride://knowledge/catalog' ? 3_600_000 : 0,
                  cacheScope: uri === 'stride://knowledge/catalog' ? 'public' : 'private',
                }
              : {}),
          },
          modern,
        );
      }
      default:
        throw Object.assign(new Error(`Method not found: ${request.method}`), { rpcCode: -32601 });
    }
  }

  private async readResource(storeId: string, uri: string) {
    if (uri === 'stride://knowledge/catalog') return this.reads.catalog();
    if (uri === 'stride://store/context') return this.reads.context(storeId);
    if (uri === 'stride://store/snapshot') return this.reads.snapshot(storeId, { days: 30 });
    throw new Error(`Unknown Stride resource: ${uri}`);
  }
}

export const mcpProtocolService = new McpProtocolService();
