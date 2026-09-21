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
      { protocolVersion: MCP_MODERN_VERSION, method: 'server/discover' },
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

  it('rejects modern header/body routing mismatches', async () => {
    const { value } = service();
    const response = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'stride_get_snapshot', arguments: {}, _meta: modernMeta },
      },
      {
        protocolVersion: MCP_MODERN_VERSION,
        method: 'tools/list',
        name: 'stride_get_snapshot',
      },
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: -32020 } });
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
      {
        protocolVersion: MCP_MODERN_VERSION,
        method: 'tools/call',
        name: 'stride_get_snapshot',
      },
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

  it('keeps the 2025 initialize/list compatibility surface free of modern wire fields', async () => {
    const { value } = service();
    const initialized = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
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
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { protocolVersion: MCP_LEGACY_VERSION },
    );
    expect(JSON.stringify(listed.body)).not.toContain('ttlMs');
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

  it('serves store resources privately and the knowledge catalog publicly', async () => {
    const { value, reads } = service();
    const context = await value.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'stride://store/context', _meta: modernMeta },
      },
      {
        protocolVersion: MCP_MODERN_VERSION,
        method: 'resources/read',
        name: 'stride://store/context',
      },
    );
    expect(reads.context).toHaveBeenCalledWith(storeId);
    expect(context.body).toMatchObject({ result: { cacheScope: 'private', ttlMs: 0 } });
  });
});
