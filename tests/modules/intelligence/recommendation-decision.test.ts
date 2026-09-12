import { describe, expect, it } from 'vitest';
import { recommendationDecision } from '../../../src/modules/intelligence/recommendation-decision.js';
import type { RecommendationDraft } from '../../../src/modules/intelligence/intelligence.types.js';

function recommendation(overrides: Partial<RecommendationDraft> = {}): RecommendationDraft {
  const start = new Date('2026-09-01T00:00:00.000Z');
  const end = new Date('2026-09-07T23:59:59.999Z');
  return {
    ruleId: 'campaign_efficiency_deterioration',
    ruleVersion: '2',
    category: 'CAMPAIGN_EFFICIENCY',
    severity: 'HIGH',
    entityType: 'CAMPAIGN',
    entityId: 'campaign-1',
    externalEntityId: 'meta-campaign-1',
    title: 'Campaign efficiency weakened while spend increased',
    summary: 'Observed spend increased while efficiency weakened.',
    suggestedAction: 'Review delivery before increasing spend further.',
    impactScore: 0.8,
    confidenceScore: 0.9,
    urgencyScore: 0.7,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'META_PROVIDER',
    limitations: [],
    observationStart: start,
    observationEnd: end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {},
    ...overrides,
  };
}

describe('recommendationDecision', () => {
  it('maps a high-severity campaign deterioration to REDUCE', () => {
    expect(recommendationDecision(recommendation())).toMatchObject({
      decisionAction: 'REDUCE',
      decisionConfidence: 'HIGH',
      decisionBasis: 'DETERMINISTIC_RULE',
    });
  });

  it('holds a medium-severity campaign deterioration instead of inventing a scale amount', () => {
    expect(recommendationDecision(recommendation({ severity: 'MEDIUM' }))).toMatchObject({
      decisionAction: 'HOLD',
      decisionBasis: 'DETERMINISTIC_RULE',
    });
  });

  it.each([
    ['creative_fatigue_symptoms', 'TEST'],
    ['underexposed_commerce_winner', 'TEST'],
    ['paid_commerce_exposure_mismatch', 'INVESTIGATE'],
    ['provider_roas_margin_trap', 'REDUCE'],
    ['inventory_spend_conflict', 'HOLD'],
    ['shared_exposure_inventory_conflict', 'HOLD'],
  ] as const)('maps %s to %s', (ruleId, expectedAction) => {
    expect(recommendationDecision(recommendation({ ruleId }))).toMatchObject({
      decisionAction: expectedAction,
      decisionBasis: 'DETERMINISTIC_RULE',
    });
  });

  it('uses the post-quality evidence grade as the user-facing confidence level', () => {
    expect(
      recommendationDecision(
        recommendation({ evidenceQuality: 'LOW', confidenceScore: 0.41 }),
      ),
    ).toMatchObject({
      decisionConfidence: 'LOW',
      decisionBasis: 'DETERMINISTIC_RULE',
    });
  });
});
