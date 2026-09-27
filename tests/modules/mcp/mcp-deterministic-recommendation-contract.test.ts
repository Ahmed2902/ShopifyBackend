import { describe, expect, it, vi } from 'vitest';
import {
  MCP_MODERN_VERSION,
  McpProtocolService,
} from '../../../src/modules/mcp/mcp-protocol.service.js';
import { MCP_TOOLS } from '../../../src/modules/mcp/mcp-tools.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const meta = {
  'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

function service() {
  const reads = {
    catalog: vi.fn(),
    context: vi.fn(),
    snapshot: vi.fn(),
  };
  const tools = { call: vi.fn() };
  return new McpProtocolService(reads as never, tools as never);
}

describe('MCP deterministic recommendation contract', () => {
  it('publishes facts and explicit thresholds without a confidence grade', async () => {
    const response = await service().handle(
      storeId,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } },
      { protocolVersion: MCP_MODERN_VERSION, method: 'tools/list' },
    );
    const result = response.body && 'result' in response.body ? response.body.result : null;
    const tools = result && typeof result === 'object' && 'tools' in result ? result.tools : [];
    const recommendationTool = Array.isArray(tools)
      ? tools.find((tool) => tool?.name === 'stride_get_recommendations')
      : null;

    expect(recommendationTool?.description).toContain('measured values');
    expect(recommendationTool?.description).toContain('explicit rule threshold crossed');
    expect(recommendationTool?.description).toContain('No probability or confidence grade is implied');
    expect(recommendationTool?.description).toContain('why did Stride flag this?');
    expect(recommendationTool?.description).not.toContain('evidence quality');
    expect(recommendationTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('keeps the canonical tool descriptor read-only and confidence-free', () => {
    const recommendationTool = MCP_TOOLS.find(
      (tool) => tool.name === 'stride_get_recommendations',
    );
    expect(recommendationTool?.description).toContain('threshold crossed');
    expect(recommendationTool?.description).not.toContain('evidence quality');
    expect(recommendationTool?.annotations.readOnlyHint).toBe(true);
  });
});
