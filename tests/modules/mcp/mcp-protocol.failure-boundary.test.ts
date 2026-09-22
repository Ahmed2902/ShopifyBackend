import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import {
  MCP_MODERN_VERSION,
  McpProtocolService,
} from '../../../src/modules/mcp/mcp-protocol.service.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const headers = {
  protocolVersion: MCP_MODERN_VERSION,
  method: 'tools/call',
  name: 'stride_get_snapshot',
};
const params = {
  name: 'stride_get_snapshot',
  arguments: {},
  _meta: {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  },
};

function service(error: Error) {
  const reads = { catalog: vi.fn(), context: vi.fn(), snapshot: vi.fn() };
  const tools = { call: vi.fn().mockRejectedValue(error) };
  return new McpProtocolService(reads as never, tools as never);
}

describe('MCP protocol failure boundary', () => {
  it('does not expose unexpected provider or database error details', async () => {
    const value = service(
      new Error('postgres connection failed for secret-user@internal-db.example:5432'),
    );

    const response = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params },
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { data: { error: 'Stride MCP request failed' } },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('internal-db.example');
    expect(JSON.stringify(response.body)).not.toContain('secret-user');
  });

  it('preserves safe client-actionable AppError messages', async () => {
    const value = service(
      new AppError(
        'Essentials includes one advertising channel. Choose the existing channel or upgrade to Pro.',
        403,
        'PLAN_AD_CHANNEL_LIMIT',
      ),
    );

    const response = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params },
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          data: {
            error:
              'Essentials includes one advertising channel. Choose the existing channel or upgrade to Pro.',
          },
        },
      },
    });
  });

  it('also hides server-side AppError messages with 5xx status codes', async () => {
    const value = service(
      new AppError('Upstream token exchange failed with credential abc123', 503, 'UPSTREAM_FAILED'),
    );

    const response = await value.handle(
      storeId,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params },
      headers,
    );

    expect(JSON.stringify(response.body)).toContain('Stride MCP request failed');
    expect(JSON.stringify(response.body)).not.toContain('abc123');
  });
});
