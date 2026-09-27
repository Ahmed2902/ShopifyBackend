import { describe, expect, it, vi } from 'vitest';
import {
  MCP_TOOLS,
  McpToolExecutor,
} from '../../../src/modules/mcp/mcp-tools.js';
import {
  presentRecommendation,
  recommendationInputsComplete,
} from '../../../src/modules/intelligence/recommendation-presentation.js';
import { recommendationDecision } from '../../../src/modules/intelligence/recommendation-decision.js';
import { recommendationOccurrenceKey } from '../../../src/modules/intelligence/recommendation-lifecycle.service.js';
import {
  unifiedPaidEntitySignals,
  type PaidEntityMetrics,
} from '../../../src/modules/advertising/unified-paid-entity.service.js';
import type { RecommendationDraft } from '../../../src/modules/intelligence/intelligence.types.js';

function metrics(overrides: Partial<PaidEntityMetrics> = {}): PaidEntityMetrics {
  return {
    evidenceAvailable: true,
    sourceRows: 10,
    spend: 100,
    impressions: 1_000,
    clicks: 100,
    ctr: 0.1,
    cpc: 1,
    cpm: 100,
    providerConversions: 10,
    providerConversionValue: 100,
    providerRoas: 1,
    ...overrides,
  };
}

function draft(overrides: Partial<RecommendationDraft> = {}): RecommendationDraft & { priority: number } {
  return {
    ruleId: 'campaign_efficiency_deterioration',
    ruleVersion: '2',
    category: 'CAMPAIGN_EFFICIENCY',
    severity: 'HIGH',
    entityType: 'CAMPAIGN',
    entityId: 'campaign-1',
    externalEntityId: 'provider-campaign-1',
    entityName: 'Campaign One',
    title: 'Campaign efficiency weakened while spend increased',
    summary: 'Observed spend increased while provider-reported efficiency weakened.',
    suggestedAction: 'Review the campaign before scaling.',
    impactScore: 0.8,
    confidenceScore: 0.9,
    urgencyScore: 0.7,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'META_PROVIDER',
    limitations: [],
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-30T00:00:00.000Z'),
    comparisonStart: new Date('2026-08-02T00:00:00.000Z'),
    comparisonEnd: new Date('2026-08-31T00:00:00.000Z'),
    evidence: {
      changes: { spend: 0.2, roas: -0.25 },
      current: { spend: 120 },
      comparison: { spend: 100 },
    },
    priority: 0.82,
    ...overrides,
  };
}

describe('deterministic recommendation contract', () => {
  it('publishes facts and explicit threshold without public confidence grades', () => {
    const value = presentRecommendation(draft());

    expect(value).toMatchObject({
      finding: {
        title: 'Campaign efficiency weakened while spend increased',
      },
      affectedEntity: {
        type: 'CAMPAIGN',
        id: 'campaign-1',
        externalId: 'provider-campaign-1',
        name: 'Campaign One',
      },
      measuredValues: {
        changes: { spend: 0.2, roas: -0.25 },
      },
      comparisonPeriod: {
        current: {
          from: new Date('2026-09-01T00:00:00.000Z'),
          to: new Date('2026-09-30T00:00:00.000Z'),
        },
        comparison: {
          from: new Date('2026-08-02T00:00:00.000Z'),
          to: new Date('2026-08-31T00:00:00.000Z'),
        },
      },
    });
    expect(value.thresholdCrossed.conditions).toEqual(
      expect.arrayContaining(['spend change >= +15%', 'ROAS change <= -20% OR CPA change >= +20%']),
    );
    expect(value).not.toHaveProperty('confidenceScore');
    expect(value).not.toHaveProperty('evidenceQuality');
    expect(recommendationDecision(value)).not.toHaveProperty('decisionConfidence');
  });

  it('emits a provider deterioration signal only when the deterministic threshold crosses', () => {
    const comparison = metrics();
    const crossing = unifiedPaidEntitySignals(
      metrics({ spend: 120, providerRoas: 0.8, providerConversionValue: 96 }),
      comparison,
    );
    const below = unifiedPaidEntitySignals(
      metrics({ spend: 114, providerRoas: 0.8, providerConversionValue: 91.2 }),
      comparison,
    );

    expect(crossing.map((item) => item.code)).toContain('SPEND_UP_EFFICIENCY_DOWN');
    expect(below.map((item) => item.code)).not.toContain('SPEND_UP_EFFICIENCY_DOWN');
  });

  it('preserves genuine zero while unavailable conversion evidence cannot become zero', () => {
    const comparison = metrics();
    const knownZero = unifiedPaidEntitySignals(
      metrics({ spend: 25, providerConversions: 0, providerConversionValue: 0, providerRoas: 0 }),
      comparison,
    );
    const unavailable = unifiedPaidEntitySignals(
      metrics({ spend: 25, providerConversions: null, providerConversionValue: null, providerRoas: null }),
      comparison,
    );

    expect(knownZero.map((item) => item.code)).toContain('NO_CONVERSION_SPEND');
    expect(unavailable.map((item) => item.code)).not.toContain('NO_CONVERSION_SPEND');
  });

  it('withholds stale and currency-incompatible recommendations instead of grading them down', () => {
    expect(
      recommendationInputsComplete(draft(), [
        {
          code: 'META_SYNC_STALE',
          status: 'WARNING',
          surface: 'META_ADVERTISING',
          message: 'stale',
        },
      ]),
    ).toBe(false);

    expect(
      recommendationInputsComplete(
        draft({ attributionPrecision: 'EXACT_PRODUCT', evidence: { mappingConfidence: 0.95 } }),
        [
          {
            code: 'META_CURRENCY_MISMATCH',
            status: 'WARNING',
            surface: 'CROSS_CHANNEL_PRODUCT_ADS',
            message: 'mismatch',
          },
        ],
      ),
    ).toBe(false);
  });

  it('preserves lifecycle occurrence identity after presentation', () => {
    const internal = draft();
    const presented = presentRecommendation(internal);
    expect(recommendationOccurrenceKey(presented)).toBe(recommendationOccurrenceKey(internal));
  });

  it('keeps MCP recommendation reads read-only and passes the factual threshold contract unchanged', async () => {
    const publicRecommendation = {
      ...presentRecommendation(draft()),
      ...recommendationDecision(draft()),
      occurrenceKey: recommendationOccurrenceKey(draft()),
      lifecycleState: 'OPEN' as const,
      lifecycleUpdatedAt: null,
    };
    const reads = {
      recommendations: vi.fn().mockResolvedValue({
        schemaVersion: '3.0',
        recommendations: [publicRecommendation],
        dataQuality: { items: [] },
      }),
    };
    const executor = new McpToolExecutor(reads as never, {} as never, {} as never);
    const result = await executor.call('store-1', 'stride_get_recommendations', {});
    const tool = MCP_TOOLS.find((item) => item.name === 'stride_get_recommendations');

    expect(result.recommendations[0].thresholdCrossed).toBeDefined();
    expect(result.recommendations[0]).not.toHaveProperty('confidenceScore');
    expect(result.recommendations[0]).not.toHaveProperty('evidenceQuality');
    expect(result.recommendations[0]).not.toHaveProperty('decisionConfidence');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});
