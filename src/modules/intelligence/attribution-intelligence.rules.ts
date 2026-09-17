import type { RecommendationDraft } from './intelligence.types.js';

export function providerFirstPartyPurchaseGapRule(input: {
  providerPurchases: number;
  firstPartyMetaPurchaseJourneys: number;
  metaTouchedSessions: number;
  attributionQuality: 'READY' | 'DEGRADED' | 'NOT_READY';
  currency: string;
  observationStart: Date;
  observationEnd: Date;
}): RecommendationDraft | null {
  if (
    input.attributionQuality !== 'READY' ||
    input.providerPurchases < 20 ||
    input.firstPartyMetaPurchaseJourneys < 10 ||
    input.metaTouchedSessions < 100
  ) return null;

  const denominator = Math.max(input.providerPurchases, input.firstPartyMetaPurchaseJourneys, 1);
  const signedGap = input.providerPurchases - input.firstPartyMetaPurchaseJourneys;
  const relativeGap = Math.abs(signedGap) / denominator;
  if (relativeGap < 0.3) return null;

  return {
    ruleId: 'provider_first_party_purchase_gap',
    ruleVersion: '1',
    category: 'ATTRIBUTION_HEALTH',
    severity: relativeGap >= 0.5 ? 'HIGH' : 'MEDIUM',
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: 'Provider and first-party purchase attribution differ materially',
    summary:
      'Meta provider-reported purchases and Stride first-party Meta-touched Shopify purchase journeys differ materially in the same reporting window.',
    suggestedAction:
      'Review attribution settings, tracking coverage and journey evidence before comparing the two purchase counts as if they used the same attribution model.',
    impactScore: Math.min(1, relativeGap),
    confidenceScore: Math.min(0.9, 0.72 + Math.min(input.metaTouchedSessions / 5_000, 1) * 0.18),
    urgencyScore: Math.min(1, 0.45 + relativeGap * 0.6),
    evidenceQuality: input.metaTouchedSessions >= 1_000 ? 'HIGH' : 'MEDIUM',
    attributionPrecision: 'STORE',
    limitations: [
      {
        code: 'ATTRIBUTION_MODELS_DIFFER',
        message:
          'This gap is diagnostic evidence only. Meta provider attribution and Stride first-party journey attribution use different models and are not expected to match exactly.',
      },
    ],
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'META_PROVIDER_VS_STRIDE_FIRST_PARTY_JOURNEY',
      currency: input.currency,
      providerPurchases: input.providerPurchases,
      firstPartyMetaPurchaseJourneys: input.firstPartyMetaPurchaseJourneys,
      metaTouchedSessions: input.metaTouchedSessions,
      signedGap,
      relativeGap,
      interpretation: 'ATTRIBUTION_MODEL_DISCREPANCY_NOT_PROVIDER_ERROR',
    },
  };
}
