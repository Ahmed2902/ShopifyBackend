import { describe, expect, it } from 'vitest';
import {
  unifiedPaidEntitySignals,
  type PaidEntityMetrics,
} from '../../../src/modules/advertising/unified-paid-entity.service.js';
import type { RecommendationDraft } from '../../../src/modules/intelligence/intelligence.types.js';
import {
  publicRecommendation,
  recommendationHasRequiredEvidence,
  recommendationThreshold,
} from '../../../src/modules/intelligence/recommendation-public-contract.js';

function metrics(overrides: Partial<PaidEntityMetrics> = {}): PaidEntityMetrics {
  return {
    evidenceAvailable: true,
    sourceRows: 1,
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

function recommendation(overrides: Partial<RecommendationDraft> = {}): RecommendationDraft & {
  priority: number;
  decisionAction: 'INVESTIGATE';
  decisionConfidence: 'HIGH';
  decisionBasis: 'DETERMINISTIC_RULE';
  decisionMessage: string;
  occurrenceKey: string;
  lifecycleState: 'OPEN';
  lifecycleUpdatedAt: null;
} {
  return {
    ruleId: 'unified_campaign_spend_up_efficiency_down',
    ruleVersion: '1',
    category: 'PAID_MEDIA_EFFICIENCY',
    severity: 'HIGH',
    entityType: 'CAMPAIGN',
    entityId: 'campaign-1',
    externalEntityId: 'external-campaign-1',
    entityName: 'Campaign 1',
    title: 'Spend up efficiency down',
    summary: 'Provider spend increased while provider-reported ROAS deteriorated.',
    suggestedAction: 'Investigate before scaling.',
    impactScore: 0.8,
    confidenceScore: 0.9,
    urgencyScore: 0.8,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'PROVIDER_REPORTED',
    limitations: [],
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-30T00:00:00.000Z'),
    comparisonStart: new Date('2026-08-02T00:00:00.000Z'),
    comparisonEnd: new Date('2026-08-31T00:00:00.000Z'),
    evidence: {
      provider: 'META',
      accountId: 'account-1',
      current: { spend: 115, providerRoas: 0.84 },
      comparison: { spend: 100, providerRoas: 1 },
    },
    priority: 0.84,
    decisionAction: 'INVESTIGATE',
    decisionConfidence: 'HIGH',
    decisionBasis: 'DETERMINISTIC_RULE',
    decisionMessage: 'Investigate before scaling.',
    occurrenceKey: 'occurrence-1',
    lifecycleState: 'OPEN',
    lifecycleUpdatedAt: null,
    ...overrides,
  };
}

describe('deterministic recommendation thresholds', () => {
  it('emits when the exact paid-media threshold is crossed', () => {
    const signals = unifiedPaidEntitySignals(
      metrics({ spend: 115, providerRoas: 0.84 }),
      metrics({ spend: 100, providerRoas: 1 }),
    );

    expect(signals.map((signal) => signal.code)).toContain('SPEND_UP_EFFICIENCY_DOWN');
    expect(recommendationThreshold('unified_campaign_spend_up_efficiency_down')).toMatchObject({
      conditions: expect.arrayContaining([
        expect.objectContaining({ metric: 'change.spend', operator: '>=', value: 0.15 }),
        expect.objectContaining({ metric: 'change.providerRoas', operator: '<=', value: -0.15 }),
      ]),
    });
  });

  it('does not emit just below the deterministic spend threshold', () => {
    const signals = unifiedPaidEntitySignals(
      metrics({ spend: 114.9, providerRoas: 0.84 }),
      metrics({ spend: 100, providerRoas: 1 }),
    );

    expect(signals.map((signal) => signal.code)).not.toContain('SPEND_UP_EFFICIENCY_DOWN');
  });

  it('preserves unavailable conversion evidence instead of treating it as zero', () => {
    const signals = unifiedPaidEntitySignals(
      metrics({ spend: 100, providerConversions: null, providerConversionValue: null, providerRoas: null }),
      metrics(),
    );

    expect(signals.map((signal) => signal.code)).not.toContain('NO_CONVERSION_SPEND');
  });

  it('preserves a genuine provider-reported zero as threshold evidence', () => {
    const signals = unifiedPaidEntitySignals(
      metrics({ spend: 100, providerConversions: 0, providerConversionValue: 0, providerRoas: 0 }),
      metrics(),
    );

    expect(signals.map((signal) => signal.code)).toContain('NO_CONVERSION_SPEND');
  });
});

describe('public recommendation contract', () => {
  it('publishes facts, period and threshold without confidence grades', () => {
    const value = publicRecommendation(recommendation());

    expect(value).toMatchObject({
      finding: 'Provider spend increased while provider-reported ROAS deteriorated.',
      affectedEntity: {
        type: 'CAMPAIGN',
        id: 'campaign-1',
        externalId: 'external-campaign-1',
        name: 'Campaign 1',
      },
      measuredValues: expect.objectContaining({ provider: 'META', accountId: 'account-1' }),
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
      thresholdCrossed: expect.objectContaining({
        description: expect.stringContaining('15%'),
      }),
      decisionBasis: 'DETERMINISTIC_RULE',
      lifecycleState: 'OPEN',
    });
    expect(value).not.toHaveProperty('confidenceScore');
    expect(value).not.toHaveProperty('evidenceQuality');
    expect(value).not.toHaveProperty('decisionConfidence');
  });

  it('withholds currency-incompatible or stale provider conclusions', () => {
    const draft = recommendation();
    expect(
      recommendationHasRequiredEvidence(draft, [
        { code: 'CURRENCY_MISMATCH', status: 'WARNING', surface: 'PAID_MEDIA' },
      ]),
    ).toBe(false);
    expect(
      recommendationHasRequiredEvidence(draft, [
        {
          code: 'STALE_SYNC',
          status: 'WARNING',
          surface: 'PAID_MEDIA',
          provider: 'META',
        },
      ]),
    ).toBe(false);
  });

  it('withholds comparison rules when comparison evidence is incomplete', () => {
    expect(
      recommendationHasRequiredEvidence(
        recommendation({
          limitations: [
            {
              code: 'COMPARISON_PROVIDER_EVIDENCE_MISSING',
              message: 'Comparison provider evidence is missing.',
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('withholds ambiguous product-mapping conclusions', () => {
    expect(
      recommendationHasRequiredEvidence(
        recommendation({
          entityType: 'PRODUCT',
          attributionPrecision: 'EXACT_PRODUCT',
          limitations: [
            { code: 'AMBIGUOUS_MAPPING', message: 'Product mapping is ambiguous.' },
          ],
        }),
      ),
    ).toBe(false);
  });
});
