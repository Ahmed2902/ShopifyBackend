import type {
  CommerceHealthEvidence,
  ProductEvidence,
  RecommendationDraft,
} from './intelligence.types.js';

const RULE_VERSION = '1';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function relativeChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null || comparison === 0) return null;
  return (current - comparison) / Math.abs(comparison);
}

function pointChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  return current - comparison;
}

function storeRecommendation(input: {
  ruleId: string;
  title: string;
  summary: string;
  suggestedAction: string;
  severity: 'MEDIUM' | 'HIGH';
  confidenceScore: number;
  impactScore: number;
  urgencyScore: number;
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date };
  evidence: Record<string, unknown>;
}): RecommendationDraft {
  return {
    ruleId: input.ruleId,
    ruleVersion: RULE_VERSION,
    category: 'COMMERCE_HEALTH',
    severity: input.severity,
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: input.title,
    summary: input.summary,
    suggestedAction: input.suggestedAction,
    impactScore: clamp01(input.impactScore),
    confidenceScore: clamp01(input.confidenceScore),
    urgencyScore: clamp01(input.urgencyScore),
    evidenceQuality: input.confidenceScore >= 0.82 ? 'HIGH' : 'MEDIUM',
    attributionPrecision: 'SHOPIFY_COMMERCE',
    limitations: [],
    observationStart: input.window.currentStart,
    observationEnd: input.window.currentEnd,
    comparisonStart: input.window.comparisonStart,
    comparisonEnd: input.window.comparisonEnd,
    evidence: input.evidence,
  };
}

export function refundRateDeteriorationRule(
  evidence: CommerceHealthEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  const current = evidence.current.refundRate;
  const comparison = evidence.comparison.refundRate;
  const points = pointChange(current, comparison);
  const relative = relativeChange(current, comparison);
  if (
    evidence.current.orders < 20 ||
    evidence.comparison.orders < 20 ||
    current === null ||
    comparison === null ||
    points === null ||
    current < 0.05 ||
    points < 0.04 ||
    (relative !== null && relative < 0.4)
  ) {
    return null;
  }

  return storeRecommendation({
    ruleId: 'refund_rate_deterioration',
    title: 'Refund pressure increased materially',
    summary: 'Refunded value represents a larger share of observed Shopify order value than in the comparison period.',
    suggestedAction: 'Inspect products and orders driving the increase before treating gross demand as healthy growth.',
    severity: points >= 0.08 ? 'HIGH' : 'MEDIUM',
    confidenceScore: Math.min(0.92, 0.7 + Math.min(evidence.current.orders, evidence.comparison.orders) / 1_000),
    impactScore: Math.max(current, points * 2),
    urgencyScore: 0.55 + points,
    window,
    evidence: {
      source: 'SHOPIFY_COMMERCE',
      current: evidence.current,
      comparison: evidence.comparison,
      refundRatePointChange: points,
      interpretation: 'Observed refund deterioration; no root cause is inferred.',
    },
  });
}

export function discountDependencyDeteriorationRule(
  evidence: CommerceHealthEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  const current = evidence.current.discountRate;
  const comparison = evidence.comparison.discountRate;
  const points = pointChange(current, comparison);
  if (
    evidence.current.orders < 20 ||
    evidence.comparison.orders < 20 ||
    current === null ||
    comparison === null ||
    points === null ||
    current < 0.1 ||
    points < 0.05
  ) {
    return null;
  }

  return storeRecommendation({
    ruleId: 'discount_dependency_deterioration',
    title: 'Sales are relying more heavily on discounts',
    summary: 'Discount value increased as a share of observed Shopify order value versus the comparison period.',
    suggestedAction: 'Review promotion mix and contribution before extending or deepening discounts.',
    severity: points >= 0.1 ? 'HIGH' : 'MEDIUM',
    confidenceScore: Math.min(0.9, 0.68 + Math.min(evidence.current.orders, evidence.comparison.orders) / 1_000),
    impactScore: Math.max(current, points * 2),
    urgencyScore: 0.45 + points,
    window,
    evidence: {
      source: 'SHOPIFY_COMMERCE',
      current: evidence.current,
      comparison: evidence.comparison,
      discountRatePointChange: points,
      interpretation: 'Observed discount dependence; promotional intent is not inferred.',
    },
  });
}

export function returningCustomerDeteriorationRule(
  evidence: CommerceHealthEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  const currentCoverage = evidence.current.knownCustomerCoverage;
  const comparisonCoverage = evidence.comparison.knownCustomerCoverage;
  const current = evidence.current.returningOrderShare;
  const comparison = evidence.comparison.returningOrderShare;
  const points = pointChange(current, comparison);
  const currentKnown = evidence.current.newOrders + evidence.current.returningOrders;
  const comparisonKnown = evidence.comparison.newOrders + evidence.comparison.returningOrders;
  if (
    currentCoverage === null ||
    comparisonCoverage === null ||
    currentCoverage < 0.8 ||
    comparisonCoverage < 0.8 ||
    currentKnown < 20 ||
    comparisonKnown < 20 ||
    current === null ||
    comparison === null ||
    points === null ||
    points > -0.1
  ) {
    return null;
  }

  return storeRecommendation({
    ruleId: 'returning_customer_deterioration',
    title: 'Returning-customer order share weakened',
    summary: 'Returning orders make up a materially smaller share of classified Shopify orders than in the comparison period.',
    suggestedAction: 'Review retention offers, replenishment cadence and returning-customer product demand before increasing acquisition pressure.',
    severity: points <= -0.2 ? 'HIGH' : 'MEDIUM',
    confidenceScore: Math.min(0.9, 0.72 + Math.min(currentKnown, comparisonKnown) / 1_000),
    impactScore: 0.45 + Math.min(0.35, Math.abs(points)),
    urgencyScore: 0.45 + Math.min(0.35, Math.abs(points)),
    window,
    evidence: {
      source: 'SHOPIFY_CUSTOMER_ORDER_CLASSIFICATION',
      current: evidence.current,
      comparison: evidence.comparison,
      returningSharePointChange: points,
      interpretation: 'Order classification only; this is not cohort retention or customer LTV.',
    },
  });
}

export function inventoryRunwayRiskRule(
  evidence: ProductEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  if (
    !evidence.inventoryTrusted ||
    evidence.daysCover === null ||
    evidence.daysCover < 0 ||
    evidence.daysCover > 7 ||
    evidence.recentUnitsPerDay === null ||
    evidence.recentUnitsPerDay <= 0 ||
    (evidence.units < 3 && evidence.revenueShare < 0.03) ||
    evidence.mappedMetaSpend > 0
  ) {
    return null;
  }

  const urgency = clamp01((7 - evidence.daysCover) / 7 + 0.45);
  return {
    ruleId: 'inventory_runway_risk',
    ruleVersion: RULE_VERSION,
    category: 'INVENTORY_RISK',
    severity: evidence.daysCover <= 3 ? 'CRITICAL' : 'HIGH',
    entityType: 'PRODUCT',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Observed stock runway is getting short',
    summary: 'Trusted Shopify inventory and recent observed unit velocity imply limited stock cover even without mapped paid-spend pressure.',
    suggestedAction: 'Confirm replenishment or protect availability before demand exhausts current stock.',
    impactScore: clamp01(Math.max(0.25, evidence.revenueShare)),
    confidenceScore: 0.82,
    urgencyScore: urgency,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'SHOPIFY_COMMERCE',
    limitations: [],
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'TRUSTED_SHOPIFY_INVENTORY_PLUS_OBSERVED_VELOCITY',
      stockAvailable: evidence.stockAvailable,
      recentUnitsPerDay: evidence.recentUnitsPerDay,
      daysCover: evidence.daysCover,
      revenueShare: evidence.revenueShare,
      inventoryInterpretation: 'CURRENT_VELOCITY_RUNWAY_NOT_FORECAST',
    },
  };
}

export function mappingCoverageDegradedRule(input: {
  mappingCoverage: number;
  totalMetaSpend: number;
  window: { start: Date; end: Date };
}): RecommendationDraft | null {
  if (input.totalMetaSpend <= 0 || input.mappingCoverage >= 0.6) return null;
  const severe = input.mappingCoverage < 0.3;
  return {
    ruleId: 'mapping_coverage_degraded',
    ruleVersion: RULE_VERSION,
    category: 'MAPPING_HEALTH',
    severity: severe ? 'HIGH' : 'MEDIUM',
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: 'A material share of Meta spend is not mapped to products',
    summary: 'Stride cannot make complete product-level paid-demand comparisons while mapping coverage is low.',
    suggestedAction: 'Review high-spend unmapped ads and confirm their product or collection targets.',
    impactScore: clamp01(1 - input.mappingCoverage),
    confidenceScore: 0.95,
    urgencyScore: severe ? 0.8 : 0.6,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'STORE',
    limitations: [],
    observationStart: input.window.start,
    observationEnd: input.window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'STRIDE_MAPPING_COVERAGE',
      mappingCoverage: input.mappingCoverage,
      unmappedCoverage: 1 - input.mappingCoverage,
      totalMetaSpend: input.totalMetaSpend,
    },
  };
}
