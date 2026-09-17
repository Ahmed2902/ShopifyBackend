import type { RecommendationDraft } from './intelligence.types.js';

export interface CommerceDecisionPeriod {
  orders: number;
  orderValue: number;
  refunds: number;
  discounts: number;
  returningOrders: number;
  unknownCustomerOrders: number;
}

export interface CommerceDecisionEvidence {
  current: CommerceDecisionPeriod;
  comparison: CommerceDecisionPeriod;
  currency: string;
  classificationCoverageCurrent: number;
  classificationCoverageComparison: number;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}

const RULE_VERSION = '1';
const MIN_ORDERS = 30;

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function points(current: number | null, comparison: number | null) {
  return current === null || comparison === null ? null : current - comparison;
}

function base(input: CommerceDecisionEvidence, args: {
  ruleId: string;
  category: 'REFUND_HEALTH' | 'DISCOUNT_DEPENDENCY' | 'CUSTOMER_RETENTION';
  title: string;
  summary: string;
  suggestedAction: string;
  severity: 'MEDIUM' | 'HIGH';
  confidence: number;
  urgency: number;
  evidence: Record<string, unknown>;
  limitations?: Array<{ code: string; message: string }>;
}): RecommendationDraft {
  return {
    ruleId: args.ruleId,
    ruleVersion: RULE_VERSION,
    category: args.category,
    severity: args.severity,
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: args.title,
    summary: args.summary,
    suggestedAction: args.suggestedAction,
    impactScore: 0.65,
    confidenceScore: args.confidence,
    urgencyScore: args.urgency,
    evidenceQuality: args.confidence >= 0.82 ? 'HIGH' : args.confidence >= 0.62 ? 'MEDIUM' : 'LOW',
    attributionPrecision: 'STORE',
    limitations: args.limitations ?? [],
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    evidence: args.evidence,
  };
}

export function refundDeteriorationRule(input: CommerceDecisionEvidence): RecommendationDraft | null {
  if (input.current.orders < MIN_ORDERS || input.comparison.orders < MIN_ORDERS) return null;
  const current = rate(input.current.refunds, input.current.orderValue + input.current.refunds);
  const comparison = rate(input.comparison.refunds, input.comparison.orderValue + input.comparison.refunds);
  const delta = points(current, comparison);
  if (current === null || comparison === null || delta === null || delta < 0.03) return null;
  const confidence = Math.min(0.92, 0.66 + Math.min(input.current.orders, input.comparison.orders) / 2_000);
  return base(input, {
    ruleId: 'refund_rate_deterioration',
    category: 'REFUND_HEALTH',
    severity: delta >= 0.07 ? 'HIGH' : 'MEDIUM',
    title: 'Refund pressure increased',
    summary: 'Refunded value represents a materially larger share of observed order value than in the comparison period.',
    suggestedAction: 'Inspect the products and order patterns contributing most to refunds before increasing acquisition spend.',
    confidence,
    urgency: Math.min(1, delta * 8),
    evidence: { source: 'SHOPIFY_COMMERCE', currency: input.currency, currentRefundRate: current, comparisonRefundRate: comparison, changePoints: delta, currentRefunds: input.current.refunds },
  });
}

export function discountDependencyRule(input: CommerceDecisionEvidence): RecommendationDraft | null {
  if (input.current.orders < MIN_ORDERS || input.comparison.orders < MIN_ORDERS) return null;
  const current = rate(input.current.discounts, input.current.orderValue + input.current.discounts);
  const comparison = rate(input.comparison.discounts, input.comparison.orderValue + input.comparison.discounts);
  const delta = points(current, comparison);
  if (current === null || comparison === null || delta === null || delta < 0.04) return null;
  const valueGrowth = input.comparison.orderValue > 0 ? (input.current.orderValue - input.comparison.orderValue) / input.comparison.orderValue : null;
  if (valueGrowth !== null && valueGrowth > 0.2) return null;
  const confidence = Math.min(0.9, 0.64 + Math.min(input.current.orders, input.comparison.orders) / 2_500);
  return base(input, {
    ruleId: 'discount_dependency_deterioration',
    category: 'DISCOUNT_DEPENDENCY',
    severity: delta >= 0.08 ? 'HIGH' : 'MEDIUM',
    title: 'Discount dependency increased',
    summary: 'Discounts consumed a materially larger share of observed order value without a proportionate increase in order value.',
    suggestedAction: 'Review promotions and product-level discount concentration before deepening discounts further.',
    confidence,
    urgency: Math.min(1, delta * 7),
    evidence: { source: 'SHOPIFY_COMMERCE', currency: input.currency, currentDiscountRate: current, comparisonDiscountRate: comparison, changePoints: delta, orderValueChange: valueGrowth },
  });
}

export function returningCustomerDeteriorationRule(input: CommerceDecisionEvidence): RecommendationDraft | null {
  if (input.current.orders < MIN_ORDERS || input.comparison.orders < MIN_ORDERS) return null;
  if (input.classificationCoverageCurrent < 0.8 || input.classificationCoverageComparison < 0.8) return null;
  const current = rate(input.current.returningOrders, input.current.orders - input.current.unknownCustomerOrders);
  const comparison = rate(input.comparison.returningOrders, input.comparison.orders - input.comparison.unknownCustomerOrders);
  const delta = points(current, comparison);
  if (current === null || comparison === null || delta === null || delta > -0.08) return null;
  const confidence = Math.min(0.9, 0.68 + Math.min(input.current.orders, input.comparison.orders) / 2_500);
  return base(input, {
    ruleId: 'returning_customer_deterioration',
    category: 'CUSTOMER_RETENTION',
    severity: delta <= -0.15 ? 'HIGH' : 'MEDIUM',
    title: 'Returning-order share weakened',
    summary: 'Returning customers represent a materially smaller share of classified Shopify orders than in the comparison period.',
    suggestedAction: 'Review repeat-purchase drivers, product mix and recent customer experience changes before relying on acquisition alone.',
    confidence,
    urgency: Math.min(1, Math.abs(delta) * 5),
    evidence: { source: 'SHOPIFY_CUSTOMER_JOURNEY', currentReturningShare: current, comparisonReturningShare: comparison, changePoints: delta, classificationCoverage: input.classificationCoverageCurrent },
  });
}
