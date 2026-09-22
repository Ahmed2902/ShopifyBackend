import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  McpProtocolService,
} from '../../../src/modules/mcp/mcp-protocol.service.js';
import { MCP_TOOLS } from '../../../src/modules/mcp/mcp-tools.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

function service() {
  const reads = {
    catalog: vi.fn().mockReturnValue({ domains: ['COMMERCE'] }),
    context: vi.fn().mockResolvedValue({ store: { id: storeId } }),
    snapshot: vi.fn().mockResolvedValue({ schemaVersion: '1.0' }),
  };
  const tools = {
    call: vi.fn().mockResolvedValue({ commerce: { netRevenue: 1000 } }),
  };
  return { value: new McpProtocolService(reads as never, tools as never), reads, tools };
}

function modernHeaders(method: string, name?: string) {
  return {
    protocolVersion: MCP_MODERN_VERSION,
    method,
    ...(name ? { name } : {}),
  };
}

describe('McpProtocolService', () => {
  it('serves stateless 2026 discovery with cache hints and server identity', async () => {
    const { value } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: modernMeta },
      },
      modernHeaders('server/discover'),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        supportedVersions: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION],
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Stride', version: '1.0.0' } },
      },
    });
  });

  it('lists modern tools and resources with the advertised cache model', async () => {
    const { value } = service();
    const tools = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta } },
      modernHeaders('tools/list'),
    );
    const resources = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 3, method: 'resources/list', params: { _meta: modernMeta } },
      modernHeaders('resources/list'),
    );

    expect(tools.body).toMatchObject({
      result: { tools: MCP_TOOLS, resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' },
    });
    expect(resources.body).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 3_600_000,
        cacheScope: 'public',
        resources: expect.arrayContaining([
          expect.objectContaining({ uri: 'stride://knowledge/catalog' }),
          expect.objectContaining({ uri: 'stride://store/context' }),
          expect.objectContaining({ uri: 'stride://store/snapshot' }),
        ]),
      },
    });
  });

  it.each([
    [
      'method header mismatch',
      { protocolVersion: MCP_MODERN_VERSION, method: 'tools/list', name: 'stride_get_snapshot' },
      { code: -32020, message: 'Mcp-Method header does not match JSON-RPC method' },
    ],
    [
      'name header mismatch',
      { protocolVersion: MCP_MODERN_VERSION, method: 'tools/call', name: 'stride_get_context' },
      { code: -32020, message: 'Mcp-Name header does not match request principal' },
    ],
    [
      'body/header protocol mismatch',
      { protocolVersion: MCP_MODERN_VERSION, method: 'tools/call', name: 'stride_get_snapshot' },
      { code: -32020, message: 'Protocol version header/body mismatch or missing body metadata' },
    ],
  ])('rejects modern %s', async (kind, headers, expected) => {
    const { value } = service();
    const params = {
      name: 'stride_get_snapshot',
      arguments: {},
      _meta:
        kind === 'body/header protocol mismatch'
          ? { 'io.modelcontextprotocol/protocolVersion': MCP_LEGACY_VERSION }
          : modernMeta,
    };
    const response = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params },
      headers,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: expected });
  });

  it('does not downgrade a modern body claim when the HTTP protocol header is missing', async () => {
    const { value, tools } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 'modern-no-header',
        method: 'tools/call',
        params: { name: 'stride_get_snapshot', arguments: {}, _meta: modernMeta },
      },
      { method: 'tools/call', name: 'stride_get_snapshot' },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: -32020, message: 'Protocol version header/body mismatch or missing body metadata' },
    });
    expect(tools.call).not.toHaveBeenCalled();
  });

  it('requires modern client capabilities and validates optional client info', async () => {
    const { value, tools } = service();
    const missingCapabilities = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 'no-capabilities',
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION },
        },
      },
      modernHeaders('tools/list'),
    );
    const malformedClientInfo = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 'bad-client-info',
        method: 'tools/list',
        params: {
          _meta: {
            ...modernMeta,
            'io.modelcontextprotocol/clientInfo': { name: 'test-client' },
          },
        },
      },
      modernHeaders('tools/list'),
    );

    expect(missingCapabilities.body).toMatchObject({
      error: {
        code: -32602,
        message: 'Modern MCP requests require clientCapabilities in params._meta',
      },
    });
    expect(malformedClientInfo.body).toMatchObject({
      error: {
        code: -32602,
        message: 'Modern MCP clientInfo must contain string name and version fields',
      },
    });
    expect(tools.call).not.toHaveBeenCalled();
  });

  it('rejects unsupported explicit protocol versions with supported-version metadata', async () => {
    const { value } = service();
    const response = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      { protocolVersion: '2024-01-01' },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: -32022,
        data: {
          supported: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION],
          requested: '2024-01-01',
        },
      },
    });
  });

  it('rejects non-scalar JSON-RPC ids before invoking any Stride work', async () => {
    const { value, tools, reads } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: { nested: true } as never,
        method: 'tools/call',
        params: { name: 'stride_get_snapshot', arguments: {}, _meta: modernMeta },
      },
      modernHeaders('tools/call', 'stride_get_snapshot'),
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    expect(tools.call).not.toHaveBeenCalled();
    expect(reads.snapshot).not.toHaveBeenCalled();
  });

  it('rejects non-object params without coercing them to an empty object', async () => {
    const { value, tools } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 'array-params',
        method: 'tools/call',
        params: [] as never,
      },
      modernHeaders('tools/call', 'stride_get_snapshot'),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      id: 'array-params',
      error: { code: -32602, message: 'Invalid params' },
    });
    expect(tools.call).not.toHaveBeenCalled();
  });

  it('passes only the OAuth-bound store id into tool execution', async () => {
    const { value, tools } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 'tool-1',
        method: 'tools/call',
        params: {
          name: 'stride_get_snapshot',
          arguments: { days: 30 },
          _meta: modernMeta,
        },
      },
      modernHeaders('tools/call', 'stride_get_snapshot'),
    );

    expect(tools.call).toHaveBeenCalledWith(storeId, 'stride_get_snapshot', { days: 30 });
    expect(response.body).toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: { data: { commerce: { netRevenue: 1000 } } },
        isError: false,
      },
    });
  });

  it('returns invalid-params for unknown tools before invoking the executor', async () => {
    const { value, tools } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'stride_delete_campaign', arguments: {}, _meta: modernMeta },
      },
      modernHeaders('tools/call', 'stride_delete_campaign'),
    );

    expect(response.body).toMatchObject({ error: { code: -32602 } });
    expect(tools.call).not.toHaveBeenCalled();
  });

  it('maps Zod input failures from tool execution to JSON-RPC invalid params', async () => {
    const { value, tools } = service();
    let validationError: unknown;
    try {
      z.object({ days: z.number().int().min(1) }).parse({ days: 0 });
    } catch (error) {
      validationError = error;
    }
    tools.call.mockRejectedValue(validationError);

    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'stride_get_snapshot', arguments: { days: 0 }, _meta: modernMeta },
      },
      modernHeaders('tools/call', 'stride_get_snapshot'),
    );

    expect(response.body).toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
  });

  it('serves store resources privately and the knowledge catalog publicly', async () => {
    const { value, reads } = service();
    const context = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'resources/read',
        params: { uri: 'stride://store/context', _meta: modernMeta },
      },
      modernHeaders('resources/read', 'stride://store/context'),
    );
    const catalog = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'resources/read',
        params: { uri: 'stride://knowledge/catalog', _meta: modernMeta },
      },
      modernHeaders('resources/read', 'stride://knowledge/catalog'),
    );

    expect(reads.context).toHaveBeenCalledWith(storeId);
    expect(context.body).toMatchObject({ result: { cacheScope: 'private', ttlMs: 0 } });
    expect(catalog.body).toMatchObject({ result: { cacheScope: 'public', ttlMs: 3_600_000 } });
  });

  it('rejects unknown resources without invoking an advisor read', async () => {
    const { value, reads } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'resources/read',
        params: { uri: 'stride://store/secrets', _meta: modernMeta },
      },
      modernHeaders('resources/read', 'stride://store/secrets'),
    );

    expect(response.body).toMatchObject({ error: { code: -32602 } });
    expect(reads.context).not.toHaveBeenCalled();
    expect(reads.snapshot).not.toHaveBeenCalled();
  });

  it('keeps the 2025 initialize/list/tool compatibility surface free of modern wire fields', async () => {
    const { value, tools } = service();
    const initialized = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 11, method: 'initialize', params: {} },
      { protocolVersion: MCP_LEGACY_VERSION },
    );
    expect(initialized.body).toMatchObject({
      result: {
        protocolVersion: MCP_LEGACY_VERSION,
        serverInfo: { name: 'Stride', version: '1.0.0' },
      },
    });
    expect(JSON.stringify(initialized.body)).not.toContain('resultType');

    const listed = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} },
      { protocolVersion: MCP_LEGACY_VERSION },
    );
    expect(JSON.stringify(listed.body)).not.toContain('ttlMs');

    const called = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'stride_get_snapshot', arguments: { days: 7 } },
      },
      { protocolVersion: MCP_LEGACY_VERSION },
    );
    expect(tools.call).toHaveBeenCalledWith(storeId, 'stride_get_snapshot', { days: 7 });
    expect(JSON.stringify(called.body)).not.toContain('resultType');
  });

  it('accepts JSON-RPC notifications without executing work and returns 202 with no body', async () => {
    const { value, tools, reads } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'stride_get_snapshot', arguments: {}, _meta: modernMeta },
      },
      modernHeaders('tools/call', 'stride_get_snapshot'),
    );

    expect(response).toEqual({ status: 202, body: null });
    expect(tools.call).not.toHaveBeenCalled();
    expect(reads.snapshot).not.toHaveBeenCalled();
  });

  it('keeps invalid modern notifications response-free and does not execute work', async () => {
    const { value, tools, reads } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'stride_get_snapshot',
          arguments: {},
          _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION },
        },
      },
      modernHeaders('tools/call', 'stride_get_snapshot'),
    );

    expect(response).toEqual({ status: 202, body: null });
    expect(tools.call).not.toHaveBeenCalled();
    expect(reads.snapshot).not.toHaveBeenCalled();
  });

  it('exposes only read-only tools and no caller-controlled storeId input', () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(10);
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(JSON.stringify(tool.inputSchema)).not.toContain('storeId');
    }
  });
});
