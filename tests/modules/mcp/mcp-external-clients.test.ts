import { describe, expect, it, vi } from 'vitest';
import { McpOAuthController } from '../../../src/modules/mcp/mcp-oauth.controller.js';
import {
  MCP_LEGACY_COMPATIBILITY_VERSIONS,
  MCP_MODERN_VERSION,
  McpProtocolService,
} from '../../../src/modules/mcp/mcp-protocol.service.js';

const storeId = '11111111-1111-4111-8111-111111111111';

function protocolService() {
  const reads = {
    catalog: vi.fn().mockReturnValue({ domains: ['COMMERCE'] }),
    context: vi.fn().mockResolvedValue({ store: { id: storeId } }),
    snapshot: vi.fn().mockResolvedValue({ schemaVersion: '1.0' }),
  };
  const tools = {
    call: vi.fn().mockResolvedValue({ ok: true }),
  };
  return new McpProtocolService(reads as never, tools as never);
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'external-client', version: '1.0.0' },
  };
}

describe('external MCP client compatibility', () => {
  it('publishes OAuth security metadata on every tool for clients such as ChatGPT', async () => {
    const protocol = protocolService();
    const response = await protocol.handle(
      storeId,
      {
        jsonrpc: '2.0',
        id: 'chatgpt-tools',
        method: 'tools/list',
        params: { _meta: modernMeta() },
      },
      { protocolVersion: MCP_MODERN_VERSION, method: 'tools/list' },
    );

    const tools = (response.body as { result?: { tools?: Array<Record<string, unknown>> } })?.result
      ?.tools;
    expect(tools?.length).toBeGreaterThan(0);
    for (const tool of tools ?? []) {
      expect(tool).toMatchObject({
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
        _meta: {
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
        },
      });
    }
  });

  it.each(MCP_LEGACY_COMPATIBILITY_VERSIONS)(
    'negotiates handshake-era protocol %s for clients that have not moved to the 2026 stateless era',
    async (protocolVersion) => {
      const protocol = protocolService();
      const initialized = await protocol.handle(
        storeId,
        {
          jsonrpc: '2.0',
          id: 'initialize',
          method: 'initialize',
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'generic-remote-mcp-client', version: '1.0.0' },
          },
        },
        {},
      );

      expect(initialized.status).toBe(200);
      expect(initialized.body).toMatchObject({
        result: {
          protocolVersion,
          serverInfo: { name: 'Stride', version: '1.0.0' },
        },
      });

      const listed = await protocol.handle(
        storeId,
        { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
        { protocolVersion },
      );
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ result: { tools: expect.any(Array) } });
    },
  );

  it('advertises issuer-bound OAuth responses so CIMD clients can use stable client metadata', () => {
    const service = {
      authorizationServerMetadata: vi.fn().mockReturnValue({
        issuer: 'https://api.stride.example',
        authorization_endpoint: 'https://api.stride.example/oauth/authorize',
        token_endpoint: 'https://api.stride.example/oauth/token',
      }),
    };
    const controller = new McpOAuthController(service as never);
    const json = vi.fn();
    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json,
    };

    controller.authorizationServerMetadata({} as never, response as never);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ authorization_response_iss_parameter_supported: true }),
    );
  });
});
