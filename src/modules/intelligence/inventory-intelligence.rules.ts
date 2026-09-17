import type { RecommendationDraft } from './intelligence.types.js';

export function inventoryRunwayRiskRule(input: {
  productId: string;
  shopifyProductId: string;
  productName: string;
  variantId: string;
  variantName: string | null;
  unitsSoldInWindow: number;
  unitsPerDay: number;
  available: number;
  incoming: number;
  daysCover: number | null;
  inventoryMode: string;
  observationStart: Date;
  observationEnd: Date;
}): RecommendationDraft | null {
  if (
    input.inventoryMode !== 'TRUSTED' ||
    input.daysCover === null ||
    input.daysCover < 0 ||
    input.daysCover > 10 ||
    input.unitsPerDay <= 0 ||
    input.unitsSoldInWindow < 3
  ) return null;

  const severity = input.daysCover <= 3 ? 'CRITICAL' : input.daysCover <= 7 ? 'HIGH' : 'MEDIUM';
  const confidenceScore = input.unitsSoldInWindow >= 20 ? 0.9 : input.unitsSoldInWindow >= 8 ? 0.8 : 0.68;
  return {
    ruleId: 'inventory_runway_risk',
    ruleVersion: '1',
    category: 'INVENTORY_RISK',
    severity,
    entityType: 'VARIANT',
    entityId: input.variantId,
    externalEntityId: input.shopifyProductId,
    title: 'Observed sales velocity leaves limited stock cover',
    summary: `${input.productName}${input.variantName ? ` · ${input.variantName}` : ''} has about ${input.daysCover.toFixed(1)} days of observed stock cover at recent velocity.`,
    suggestedAction: 'Confirm replenishment or protect availability before demand exhausts current stock.',
    impactScore: Math.min(1, Math.max(0.25, input.unitsPerDay / 5)),
    confidenceScore,
    urgencyScore: Math.min(1, Math.max(0.45, (10 - input.daysCover) / 7)),
    evidenceQuality: confidenceScore >= 0.82 ? 'HIGH' : confidenceScore >= 0.62 ? 'MEDIUM' : 'LOW',
    attributionPrecision: 'STORE',
    limitations: [],
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'TRUSTED_SHOPIFY_INVENTORY_PLUS_OBSERVED_COMMERCE_VELOCITY',
      available: input.available,
      incoming: input.incoming,
      unitsSoldInWindow: input.unitsSoldInWindow,
      unitsPerDay: input.unitsPerDay,
      daysCover: input.daysCover,
      interpretation: 'CURRENT_VELOCITY_RUNWAY_NOT_FORECAST',
    },
  };
}
