import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('recommendation public contract source boundary', () => {
  it('keeps confidence grades internal while public presentation exposes deterministic facts', async () => {
    const source = await readFile(
      'src/modules/intelligence/recommendation-presentation.ts',
      'utf8',
    );
    expect(source).toContain('finding: { title, summary }');
    expect(source).toContain('affectedEntity: {');
    expect(source).toContain('measuredValues: recommendation.evidence');
    expect(source).toContain('comparisonPeriod: {');
    expect(source).toContain('thresholdCrossed: recommendationThresholdCrossed');
    expect(source).toContain('confidenceScore: _confidenceScore');
    expect(source).toContain('evidenceQuality: _evidenceQuality');
  });

  it('does not advertise a public confidence model in unified decisions or MCP recommendations', async () => {
    const [decisionSource, mcpSource] = await Promise.all([
      readFile('src/modules/intelligence/unified-decision.service.ts', 'utf8'),
      readFile('src/modules/mcp/mcp-tools.ts', 'utf8'),
    ]);
    expect(decisionSource).not.toContain('confidenceModel:');
    expect(mcpSource).toContain('explicit rule threshold crossed');
    expect(mcpSource).toContain('rather than assigned a confidence grade');
  });
});
