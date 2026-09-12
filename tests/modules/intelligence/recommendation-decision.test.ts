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
  it.each([
    [
      'campaign_efficiency_deterioration',
      'HIGH',
      'REDUCE',
      'Reduce or cap further spend while you investigate the efficiency deterioration.',
    ],
    [
      'campaign_efficiency_deterioration',
      'MEDIUM',
      'HOLD',
      'Hold the current budget and investigate the efficiency deterioration before scaling further.',
    ],
    [
      'creative_fatigue_symptoms',
      'HIGH',
      'TEST',
      'Prepare and test a replacement creative before the current fatigue symptoms worsen.',
    ],
    [
      'underexposed_commerce_winner',
      'HIGH',
      'TEST',
      'Run a controlled paid-traffic test; do not treat this signal as an automatic budget increase.',
    ],
    [
      'paid_commerce_exposure_mismatch',
      'HIGH',
      'INVESTIGATE',
      'Investigate traffic fit, product offer and landing experience before increasing exposure.',
    ],
    [
      'provider_roas_margin_trap',
      'HIGH',
      'REDUCE',
      'Reduce further scaling pressure and review product economics before trusting provider ROAS as a growth signal.',
    ],
    [
      'inventory_spend_conflict',
      'HIGH',
      'HOLD',
      'Hold aggressive paid scaling until replenishment or inventory protection is confirmed.',
    ],
    [
      'shared_exposure_inventory_conflict',
      'HIGH',
      'HOLD',
      'Hold aggressive paid scaling until replenishment or inventory protection is confirmed.',
    ],
  ] as const)(
    'maps %s (%s severity) to %s with the intended merchant-facing message',
    (ruleId, severity, expectedAction, expectedMessage) => {
      expect(recommendationDecision(recommendation({ ruleId, severity }))).toEqual({
        decisionAction: expectedAction,
        decisionConfidence: 'HIGH',
        decisionBasis: 'DETERMINISTIC_RULE',
        decisionMessage: expectedMessage,
      });
    },
  );

  it.each([
    ['HIGH', 0.92],
    ['MEDIUM', 0.67],
    ['LOW', 0.41],
  ] as const)(
    'uses the post-quality %s evidence grade as the user-facing confidence level',
    (evidenceQuality, confidenceScore) => {
      expect(
        recommendationDecision(recommendation({ evidenceQuality, confidenceScore })),
      ).toMatchObject({
        decisionConfidence: evidenceQuality,
        decisionBasis: 'DETERMINISTIC_RULE',
      });
    },
  );

  it('keeps unknown future rules conservative and preserves their suggested action copy', () => {
    expect(
      recommendationDecision(
        recommendation({
          ruleId: 'future_rule',
          suggestedAction: 'Review this signal before making a change.',
        }),
      ),
    ).toEqual({
      decisionAction: 'INVESTIGATE',
      decisionConfidence: 'HIGH',
      decisionBasis: 'DETERMINISTIC_RULE',
      decisionMessage: 'Review this signal before making a change.',
    });
  });
});
