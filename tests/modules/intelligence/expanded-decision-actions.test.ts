import { describe, expect, it } from 'vitest';
import { recommendationDecision } from '../../../src/modules/intelligence/recommendation-decision.js';
import type { RecommendationDraft } from '../../../src/modules/intelligence/intelligence.types.js';

function recommendation(ruleId: string): RecommendationDraft {
  return {
    ruleId,
    ruleVersion: '1',
    category: 'STOREFRONT_FUNNEL',
    severity: 'HIGH',
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: 'Example',
    summary: 'Example',
    suggestedAction: 'Investigate this signal.',
    impactScore: 0.8,
    confidenceScore: 0.9,
    urgencyScore: 0.8,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'FIRST_PARTY_OBSERVED',
    limitations: [],
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-07T23:59:59.999Z'),
    comparisonStart: new Date('2026-08-25T00:00:00.000Z'),
    comparisonEnd: new Date('2026-08-31T23:59:59.999Z'),
    evidence: {},
  };
}

describe('expanded deterministic decision actions', () => {
  it('keeps storefront, attribution and commerce diagnoses as investigations', () => {
    for (const ruleId of [
      'checkout_abandonment_deterioration',
      'high_traffic_low_conversion_product',
      'provider_first_party_purchase_gap',
    ]) {
      expect(recommendationDecision(recommendation(ruleId))).toMatchObject({
        decisionAction: 'INVESTIGATE',
        decisionBasis: 'DETERMINISTIC_RULE',
      });
    }
  });

  it('reduces high-severity paid hierarchy deterioration consistently', () => {
    for (const ruleId of [
      'campaign_efficiency_deterioration',
      'adset_efficiency_deterioration',
      'ad_efficiency_deterioration',
    ]) {
      expect(recommendationDecision(recommendation(ruleId))).toMatchObject({
        decisionAction: 'REDUCE',
        decisionConfidence: 'HIGH',
      });
    }
  });

  it('holds inventory runway risk instead of inventing a forecast action', () => {
    expect(recommendationDecision(recommendation('inventory_runway_risk'))).toMatchObject({
      decisionAction: 'HOLD',
    });
  });

  it('tests a deteriorating video creative instead of auto-pausing it', () => {
    expect(recommendationDecision(recommendation('video_retention_deterioration'))).toMatchObject({
      decisionAction: 'TEST',
    });
  });
});
