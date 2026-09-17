import type {
  RecommendationDraft,
  RecommendationSeverity,
  StorefrontBehaviorEvidence,
} from './intelligence.types.js';

const RULE_VERSION = '1';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function delta(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  return current - comparison;
}

function relativeChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null || comparison === 0) return null;
  return (current - comparison) / Math.abs(comparison);
}

function confidence(sample: number, comparisonSample: number) {
  const support = Math.min(sample, comparisonSample);
  if (support >= 250) return { score: 0.9, quality: 'HIGH' as const };
  if (support >= 75) return { score: 0.76, quality: 'MEDIUM' as const };
  return { score: 0.62, quality: 'MEDIUM' as const };
}

function severity(points: number, highAt: number): RecommendationSeverity {
  return points >= highAt ? 'HIGH' : 'MEDIUM';
}

function entityType(evidence: StorefrontBehaviorEvidence): 'STORE' | 'PRODUCT' | 'LANDING_PAGE' {
  return evidence.dimension;
}

function base(input: {
  evidence: StorefrontBehaviorEvidence;
  category: RecommendationDraft['category'];
  ruleId: string;
  title: string;
  summary: string;
  suggestedAction: string;
  severity: RecommendationSeverity;
  sample: number;
  comparisonSample: number;
  impact: number;
  urgency: number;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
  payload: Record<string, unknown>;
  interpretation?: string;
}): RecommendationDraft {
  const support = confidence(input.sample, input.comparisonSample);
  return {
    ruleId: input.ruleId,
    ruleVersion: RULE_VERSION,
    category: input.category,
    severity: input.severity,
    entityType: entityType(input.evidence),
    entityId: input.evidence.entityId,
    externalEntityId: input.evidence.externalEntityId,
    title: input.title,
    summary: input.summary,
    suggestedAction: input.suggestedAction,
    impactScore: clamp01(input.impact),
    confidenceScore: support.score,
    urgencyScore: clamp01(input.urgency),
    evidenceQuality: support.quality,
    attributionPrecision: 'FIRST_PARTY_OBSERVED',
    limitations: [],
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    evidence: {
      source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS',
      current: input.evidence.current,
      comparison: input.evidence.comparison,
      ...input.payload,
      interpretation:
        input.interpretation ?? 'Observed behavior change; no causal explanation is implied.',
    },
  };
}

export function cartAbandonmentDeteriorationRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'STORE') return null;
  const current = evidence.current.cartAbandonmentRate;
  const previous = evidence.comparison.cartAbandonmentRate;
  const points = delta(current, previous);
  if (
    evidence.current.cartViewSessions < 30 ||
    evidence.comparison.cartViewSessions < 30 ||
    current === null ||
    previous === null ||
    points === null ||
    current < 0.45 ||
    points < 0.1
  ) {
    return null;
  }

  return base({
    evidence,
    category: 'STOREFRONT_FUNNEL',
    ruleId: 'cart_abandonment_deterioration',
    title: 'Cart abandonment increased materially',
    summary: 'A larger share of observed cart-view sessions failed to reach a linked Shopify purchase than in the comparison period.',
    suggestedAction: 'Inspect cart-to-checkout and checkout completion before changing acquisition spend.',
    severity: severity(points, 0.18),
    sample: evidence.current.cartViewSessions,
    comparisonSample: evidence.comparison.cartViewSessions,
    impact: Math.max(current, points * 2),
    urgency: 0.55 + points,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: { abandonmentRatePointChange: points },
  });
}

export function checkoutAbandonmentDeteriorationRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'STORE') return null;
  const current = evidence.current.checkoutAbandonmentRate;
  const previous = evidence.comparison.checkoutAbandonmentRate;
  const points = delta(current, previous);
  if (
    evidence.current.checkoutStartSessions < 25 ||
    evidence.comparison.checkoutStartSessions < 25 ||
    current === null ||
    previous === null ||
    points === null ||
    current < 0.3 ||
    points < 0.08
  ) {
    return null;
  }

  return base({
    evidence,
    category: 'STOREFRONT_FUNNEL',
    ruleId: 'checkout_abandonment_deterioration',
    title: 'Checkout completion weakened',
    summary: 'Observed checkout starts are reaching a linked valid Shopify purchase less often than in the comparison period.',
    suggestedAction: 'Investigate checkout friction, payment failures and shipping/offer changes before pushing more traffic.',
    severity: severity(points, 0.15),
    sample: evidence.current.checkoutStartSessions,
    comparisonSample: evidence.comparison.checkoutStartSessions,
    impact: Math.max(current, points * 2),
    urgency: 0.6 + points,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: {
      abandonmentRatePointChange: points,
      completionSource: 'SAME_SESSION_LINKED_VALID_SHOPIFY_PURCHASE',
    },
  });
}

export function viewToCartDeteriorationRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'STORE') return null;
  const current = evidence.current.viewToCartRate;
  const previous = evidence.comparison.viewToCartRate;
  const points = delta(current, previous);
  const relative = relativeChange(current, previous);
  if (
    evidence.current.productViewSessions < 75 ||
    evidence.comparison.productViewSessions < 75 ||
    current === null ||
    previous === null ||
    points === null ||
    relative === null ||
    points > -0.04 ||
    relative > -0.25
  ) {
    return null;
  }

  return base({
    evidence,
    category: 'STOREFRONT_FUNNEL',
    ruleId: 'view_to_cart_deterioration',
    title: 'Product views are turning into carts less often',
    summary: 'Observed product-view sessions are progressing to add-to-cart materially less often than in the comparison period.',
    suggestedAction: 'Review the product offer and product-page experience before increasing traffic.',
    severity: severity(Math.abs(points), 0.08),
    sample: evidence.current.productViewSessions,
    comparisonSample: evidence.comparison.productViewSessions,
    impact: 0.45 + clamp01(Math.abs(relative)) * 0.35,
    urgency: 0.5 + clamp01(Math.abs(relative)) * 0.3,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: { ratePointChange: points, relativeChange: relative },
  });
}

export function storefrontConversionDeteriorationRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'STORE') return null;
  const current = evidence.current.linkedPurchaseRate;
  const previous = evidence.comparison.linkedPurchaseRate;
  const points = delta(current, previous);
  const relative = relativeChange(current, previous);
  if (
    evidence.current.sessions < 150 ||
    evidence.comparison.sessions < 150 ||
    current === null ||
    previous === null ||
    points === null ||
    relative === null ||
    points > -0.01 ||
    relative > -0.2
  ) {
    return null;
  }

  return base({
    evidence,
    category: 'STOREFRONT_FUNNEL',
    ruleId: 'storefront_conversion_deterioration',
    title: 'Storefront purchase conversion weakened',
    summary: 'A smaller share of observed sessions reached a linked Shopify purchase than in the comparison period.',
    suggestedAction: 'Use the funnel breakdown to identify whether the loss is before cart, in cart, or during checkout.',
    severity: severity(Math.abs(points), 0.025),
    sample: evidence.current.sessions,
    comparisonSample: evidence.comparison.sessions,
    impact: 0.55 + clamp01(Math.abs(relative)) * 0.3,
    urgency: 0.55 + clamp01(Math.abs(relative)) * 0.25,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: {
      ratePointChange: points,
      relativeChange: relative,
      largestFunnelDropStage: evidence.current.largestFunnelDropStage,
      largestFunnelDropRate: evidence.current.largestFunnelDropRate,
    },
  });
}

export function productConversionDeteriorationRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'PRODUCT' || !evidence.entityId) return null;

  const absoluteWeakness = highTrafficLowConversionProductRule(evidence, window);
  if (absoluteWeakness) return absoluteWeakness;

  const current = evidence.current.linkedPurchaseRate;
  const previous = evidence.comparison.linkedPurchaseRate;
  const points = delta(current, previous);
  const relative = relativeChange(current, previous);
  if (
    evidence.current.productViewSessions < 40 ||
    evidence.comparison.productViewSessions < 40 ||
    current === null ||
    previous === null ||
    points === null ||
    relative === null ||
    points > -0.015 ||
    relative > -0.3
  ) {
    return null;
  }

  return base({
    evidence,
    category: 'PRODUCT_CONVERSION',
    ruleId: 'product_conversion_deterioration',
    title: `${evidence.name} is converting worse than its recent baseline`,
    summary: 'Observed product sessions are reaching linked Shopify purchases materially less often than in the comparison period.',
    suggestedAction: 'Inspect product-page engagement, cart progression, inventory and offer changes before adding traffic.',
    severity: severity(Math.abs(points), 0.04),
    sample: evidence.current.productViewSessions,
    comparisonSample: evidence.comparison.productViewSessions,
    impact: 0.45 + clamp01(evidence.current.productViewSessions / 500) * 0.35,
    urgency: 0.5 + clamp01(Math.abs(relative)) * 0.3,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: { ratePointChange: points, relativeChange: relative },
  });
}

export function highTrafficLowConversionProductRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'PRODUCT' || !evidence.entityId) return null;
  const purchaseRate = evidence.current.linkedPurchaseRate;
  if (
    evidence.current.productViewSessions < 150 ||
    purchaseRate === null ||
    purchaseRate > 0.015
  ) {
    return null;
  }

  const currentViews = evidence.current.productViewSessions;
  return base({
    evidence,
    category: 'PRODUCT_CONVERSION',
    ruleId: 'high_traffic_low_conversion_product',
    title: `${evidence.name} attracts attention but converts weakly`,
    summary: 'This product has substantial observed product-view traffic but a very low linked Shopify purchase rate.',
    suggestedAction: 'Investigate product-page intent, offer clarity, inventory and downstream checkout progression before buying more traffic.',
    severity: currentViews >= 500 && purchaseRate <= 0.01 ? 'HIGH' : 'MEDIUM',
    sample: currentViews,
    comparisonSample: Math.max(currentViews, evidence.comparison.productViewSessions),
    impact: 0.45 + clamp01(currentViews / 1_000) * 0.4,
    urgency: 0.55 + clamp01((0.015 - purchaseRate) / 0.015) * 0.25,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: {
      productViewSessions: currentViews,
      linkedPurchaseSessions: evidence.current.linkedPurchaseSessions,
      linkedPurchaseRate: purchaseRate,
    },
    interpretation:
      'High observed interest with weak downstream purchase conversion; no cause is inferred.',
  });
}

export function landingPageQualityDeteriorationRule(
  evidence: StorefrontBehaviorEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.dimension !== 'LANDING_PAGE') return null;
  const current = evidence.current.linkedPurchaseRate;
  const previous = evidence.comparison.linkedPurchaseRate;
  const points = delta(current, previous);
  const relative = relativeChange(current, previous);
  if (
    evidence.current.sessions < 75 ||
    evidence.comparison.sessions < 75 ||
    current === null ||
    previous === null ||
    points === null ||
    relative === null ||
    points > -0.015 ||
    relative > -0.3
  ) {
    return null;
  }

  return base({
    evidence,
    category: 'LANDING_PAGE_QUALITY',
    ruleId: 'landing_page_quality_deterioration',
    title: 'A high-traffic landing route is converting worse',
    summary: `${evidence.name} is producing fewer linked purchases per observed session than in the comparison period.`,
    suggestedAction: 'Inspect the landing experience and downstream product engagement before sending more traffic to this route.',
    severity: severity(Math.abs(points), 0.04),
    sample: evidence.current.sessions,
    comparisonSample: evidence.comparison.sessions,
    impact: 0.4 + clamp01(evidence.current.sessions / 1_000) * 0.4,
    urgency: 0.45 + clamp01(Math.abs(relative)) * 0.35,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    payload: { ratePointChange: points, relativeChange: relative },
  });
}
