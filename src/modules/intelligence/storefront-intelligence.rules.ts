import type {
  RecommendationDraft,
  RecommendationLimitation,
  StorefrontEvidence,
  StorefrontFunnelMetrics,
} from './intelligence.types.js';

const RULE_VERSION = '1';
const MIN_STORE_SESSIONS = 100;
const MIN_ENTITY_SESSIONS = 50;
const MIN_CHECKOUT_STARTS = 30;
const MIN_CART_VIEWS = 30;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function points(current: number | null, comparison: number | null): number | null {
  return current === null || comparison === null ? null : current - comparison;
}

function round(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function limitations(evidence: StorefrontEvidence): RecommendationLimitation[] {
  return evidence.limitations.map((code) => ({
    code,
    message: 'Stride Pixel behavior evidence has an active data-quality limitation.',
  }));
}

function confidence(evidence: StorefrontEvidence, support: number) {
  const qualityFactor = evidence.qualityState === 'READY' ? 1 : evidence.qualityState === 'DEGRADED' ? 0.78 : 0.5;
  return clamp01((0.62 + support * 0.28) * qualityFactor);
}

function evidenceQuality(score: number, evidence: StorefrontEvidence) {
  if (evidence.qualityState === 'READY' && score >= 0.82) return 'HIGH' as const;
  if (score >= 0.58) return 'MEDIUM' as const;
  return 'LOW' as const;
}

function baseDraft(input: {
  evidence: StorefrontEvidence;
  window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date };
  ruleId: string;
  category: RecommendationDraft['category'];
  title: string;
  summary: string;
  suggestedAction: string;
  severity: RecommendationDraft['severity'];
  impact: number;
  urgency: number;
  support: number;
  payload: Record<string, unknown>;
}): RecommendationDraft {
  const score = confidence(input.evidence, input.support);
  const activeLimitations = limitations(input.evidence);
  return {
    ruleId: input.ruleId,
    ruleVersion: RULE_VERSION,
    category: input.category,
    severity: input.severity,
    entityType: input.evidence.entityType,
    entityId: input.evidence.entityId,
    externalEntityId: input.evidence.externalEntityId,
    title: input.title,
    summary: input.summary,
    suggestedAction: input.suggestedAction,
    impactScore: clamp01(input.impact),
    confidenceScore: score,
    urgencyScore: clamp01(input.urgency),
    evidenceQuality: evidenceQuality(score, input.evidence),
    attributionPrecision: input.evidence.entityType === 'STORE' ? 'STORE' : 'UNKNOWN',
    limitations: activeLimitations,
    observationStart: input.window.start,
    observationEnd: input.window.end,
    comparisonStart: input.window.comparisonStart,
    comparisonEnd: input.window.comparisonEnd,
    evidence: {
      source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS',
      entityName: input.evidence.name,
      current: input.evidence.current,
      comparison: input.evidence.comparison,
      ...input.payload,
      interpretation: 'OBSERVED_BEHAVIOR_NOT_CAUSAL_DIAGNOSIS',
    },
  };
}

export function cartAbandonmentDeteriorationRule(
  evidence: StorefrontEvidence,
  window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  const current = evidence.current.cartViewAbandonmentRate;
  const previous = evidence.comparison.cartViewAbandonmentRate;
  const delta = points(current, previous);
  if (
    evidence.qualityState === 'NOT_READY' ||
    evidence.current.cartViewSessions < MIN_CART_VIEWS ||
    evidence.comparison.cartViewSessions < MIN_CART_VIEWS ||
    current === null ||
    previous === null ||
    delta === null ||
    delta < 0.08
  ) return null;

  return baseDraft({
    evidence,
    window,
    ruleId: 'cart_abandonment_deterioration',
    category: 'CART_ABANDONMENT',
    title: 'Cart abandonment increased materially',
    summary: 'A larger share of observed cart-view sessions failed to reach a linked Shopify purchase than in the comparison period.',
    suggestedAction: 'Investigate checkout friction, shipping, offer clarity and cart-to-checkout behavior before driving more traffic.',
    severity: delta >= 0.15 ? 'HIGH' : 'MEDIUM',
    impact: Math.max(0.2, evidence.current.cartViewSessions / Math.max(evidence.current.sessions, 1)),
    urgency: 0.55 + clamp01(delta * 2),
    support: clamp01(Math.min(evidence.current.cartViewSessions, evidence.comparison.cartViewSessions) / 250),
    payload: { cartAbandonmentRatePoints: round(delta) },
  });
}

export function checkoutAbandonmentDeteriorationRule(
  evidence: StorefrontEvidence,
  window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  const current = evidence.current.checkoutAbandonmentRate;
  const previous = evidence.comparison.checkoutAbandonmentRate;
  const delta = points(current, previous);
  if (
    evidence.qualityState === 'NOT_READY' ||
    evidence.current.checkoutStartSessions < MIN_CHECKOUT_STARTS ||
    evidence.comparison.checkoutStartSessions < MIN_CHECKOUT_STARTS ||
    current === null ||
    previous === null ||
    delta === null ||
    delta < 0.08
  ) return null;

  return baseDraft({
    evidence,
    window,
    ruleId: 'checkout_abandonment_deterioration',
    category: 'CHECKOUT_ABANDONMENT',
    title: 'Checkout abandonment increased materially',
    summary: 'Pixel-observed checkout completion weakened versus the comparison period.',
    suggestedAction: 'Inspect checkout errors, payment/shipping friction and recent storefront changes before scaling traffic.',
    severity: delta >= 0.15 ? 'HIGH' : 'MEDIUM',
    impact: Math.max(0.2, evidence.current.checkoutStartSessions / Math.max(evidence.current.sessions, 1)),
    urgency: 0.6 + clamp01(delta * 2),
    support: clamp01(Math.min(evidence.current.checkoutStartSessions, evidence.comparison.checkoutStartSessions) / 200),
    payload: { checkoutAbandonmentRatePoints: round(delta) },
  });
}

export function storefrontConversionDeteriorationRule(
  evidence: StorefrontEvidence,
  window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.entityType !== 'STORE') return null;
  const current = evidence.current.linkedPurchaseRate;
  const previous = evidence.comparison.linkedPurchaseRate;
  const delta = points(current, previous);
  if (
    evidence.qualityState === 'NOT_READY' ||
    evidence.current.sessions < MIN_STORE_SESSIONS ||
    evidence.comparison.sessions < MIN_STORE_SESSIONS ||
    current === null ||
    previous === null ||
    delta === null ||
    delta > -0.02
  ) return null;

  return baseDraft({
    evidence,
    window,
    ruleId: 'storefront_conversion_deterioration',
    category: 'STOREFRONT_CONVERSION',
    title: 'Storefront purchase conversion weakened',
    summary: 'The share of observed sessions linked to valid Shopify purchases decreased versus the comparison period.',
    suggestedAction: 'Review the funnel stages with the largest deterioration before increasing acquisition spend.',
    severity: delta <= -0.05 ? 'HIGH' : 'MEDIUM',
    impact: 0.75,
    urgency: 0.55 + clamp01(Math.abs(delta) * 4),
    support: clamp01(Math.min(evidence.current.sessions, evidence.comparison.sessions) / 1_000),
    payload: { linkedPurchaseRatePoints: round(delta) },
  });
}

export function viewToCartDeteriorationRule(
  evidence: StorefrontEvidence,
  window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  const minimum = evidence.entityType === 'STORE' ? MIN_STORE_SESSIONS : MIN_ENTITY_SESSIONS;
  const current = evidence.current.viewToCartRate;
  const previous = evidence.comparison.viewToCartRate;
  const delta = points(current, previous);
  if (
    evidence.qualityState === 'NOT_READY' ||
    evidence.current.productViewSessions < minimum ||
    evidence.comparison.productViewSessions < minimum ||
    current === null ||
    previous === null ||
    delta === null ||
    delta > -0.04
  ) return null;

  return baseDraft({
    evidence,
    window,
    ruleId: evidence.entityType === 'PRODUCT' ? 'product_view_to_cart_deterioration' : 'view_to_cart_deterioration',
    category: evidence.entityType === 'PRODUCT' ? 'PRODUCT_CONVERSION' : 'STOREFRONT_CONVERSION',
    title: evidence.entityType === 'PRODUCT' ? 'Product interest is converting to carts less often' : 'View-to-cart progression weakened',
    summary: 'Observed product-view sessions are progressing to add-to-cart less often than in the comparison period.',
    suggestedAction: 'Inspect product offer, pricing, merchandising and page experience before increasing traffic.',
    severity: delta <= -0.08 ? 'HIGH' : 'MEDIUM',
    impact: evidence.entityType === 'PRODUCT' ? 0.45 : 0.65,
    urgency: 0.5 + clamp01(Math.abs(delta) * 3),
    support: clamp01(Math.min(evidence.current.productViewSessions, evidence.comparison.productViewSessions) / 500),
    payload: { viewToCartRatePoints: round(delta) },
  });
}

export function highTrafficLowConversionRule(
  evidence: StorefrontEvidence,
  window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (evidence.entityType !== 'PRODUCT' && evidence.entityType !== 'LANDING_PAGE') return null;
  const rate = evidence.current.linkedPurchaseRate;
  if (
    evidence.qualityState === 'NOT_READY' ||
    evidence.current.sessions < 100 ||
    rate === null ||
    rate >= 0.01
  ) return null;

  return baseDraft({
    evidence,
    window,
    ruleId: evidence.entityType === 'PRODUCT' ? 'high_traffic_low_conversion_product' : 'high_traffic_low_conversion_landing_page',
    category: evidence.entityType === 'PRODUCT' ? 'PRODUCT_CONVERSION' : 'LANDING_PAGE_QUALITY',
    title: evidence.entityType === 'PRODUCT' ? 'High product traffic is producing few purchases' : 'Landing page traffic is producing few purchases',
    summary: 'This surface receives meaningful observed traffic but very few sessions link to a valid Shopify purchase.',
    suggestedAction: 'Investigate traffic fit and downstream page experience before sending additional traffic here.',
    severity: evidence.current.sessions >= 500 ? 'HIGH' : 'MEDIUM',
    impact: clamp01(evidence.current.sessions / 1_000),
    urgency: 0.6,
    support: clamp01(evidence.current.sessions / 500),
    payload: { linkedPurchaseRate: round(rate) },
  });
}

export function storefrontFunnelEvidence(metrics: Record<string, unknown>): StorefrontFunnelMetrics {
  return metrics as unknown as StorefrontFunnelMetrics;
}
