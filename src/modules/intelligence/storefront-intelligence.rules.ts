import type { RecommendationDraft } from './intelligence.types.js';
import type { StorefrontDimensionEvidence, StorefrontEvidence } from './storefront-intelligence.types.js';

const RULE_VERSION = '1';
const MIN_STORE_SESSIONS = 250;
const MIN_STAGE_SESSIONS = 100;
const MIN_PRODUCT_SESSIONS = 100;
const MIN_LANDING_SESSIONS = 150;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function points(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  return current - comparison;
}

function confidenceFor(sessions: number, base = 0.62) {
  return clamp01(base + Math.min(sessions / 5_000, 1) * 0.28);
}

function storefrontRecommendation(evidence: StorefrontEvidence, input: {
  ruleId: string;
  category: 'STOREFRONT_CONVERSION' | 'CART_ABANDONMENT' | 'CHECKOUT_ABANDONMENT';
  severity: 'MEDIUM' | 'HIGH';
  title: string;
  summary: string;
  suggestedAction: string;
  confidence: number;
  impact: number;
  urgency: number;
  payload: Record<string, unknown>;
}): RecommendationDraft {
  return {
    ruleId: input.ruleId,
    ruleVersion: RULE_VERSION,
    category: input.category,
    severity: input.severity,
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: input.title,
    summary: input.summary,
    suggestedAction: input.suggestedAction,
    impactScore: clamp01(input.impact),
    confidenceScore: clamp01(input.confidence),
    urgencyScore: clamp01(input.urgency),
    evidenceQuality: input.confidence >= 0.82 ? 'HIGH' : input.confidence >= 0.62 ? 'MEDIUM' : 'LOW',
    attributionPrecision: 'STORE',
    limitations: evidence.limitations,
    observationStart: evidence.observationStart,
    observationEnd: evidence.observationEnd,
    comparisonStart: evidence.comparisonStart,
    comparisonEnd: evidence.comparisonEnd,
    evidence: input.payload,
  };
}

export function cartAbandonmentDeteriorationRule(evidence: StorefrontEvidence): RecommendationDraft | null {
  const current = evidence.current;
  const comparison = evidence.comparison;
  if (current.cartViewSessions < MIN_STAGE_SESSIONS || comparison.cartViewSessions < MIN_STAGE_SESSIONS) return null;
  const delta = points(current.cartAbandonmentRate, comparison.cartAbandonmentRate);
  if (delta === null || delta < 0.08 || current.cartAbandonmentRate === null) return null;
  const confidence = confidenceFor(Math.min(current.cartViewSessions, comparison.cartViewSessions), 0.66);
  return storefrontRecommendation(evidence, {
    ruleId: 'cart_abandonment_deterioration',
    category: 'CART_ABANDONMENT',
    severity: delta >= 0.15 ? 'HIGH' : 'MEDIUM',
    title: 'Cart abandonment increased materially',
    summary: 'A larger share of observed cart-view sessions failed to reach a linked valid Shopify purchase than in the comparison period.',
    suggestedAction: 'Investigate the cart-to-checkout and checkout-to-purchase experience before increasing traffic.',
    confidence,
    impact: Math.min(current.cartViewSessions / Math.max(current.sessions, 1), 1),
    urgency: clamp01(delta * 4),
    payload: { source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS', current: current.cartAbandonmentRate, comparison: comparison.cartAbandonmentRate, changePoints: delta, cartViewSessions: current.cartViewSessions },
  });
}

export function checkoutAbandonmentDeteriorationRule(evidence: StorefrontEvidence): RecommendationDraft | null {
  const current = evidence.current;
  const comparison = evidence.comparison;
  if (current.checkoutStartSessions < MIN_STAGE_SESSIONS || comparison.checkoutStartSessions < MIN_STAGE_SESSIONS) return null;
  const delta = points(current.checkoutAbandonmentRate, comparison.checkoutAbandonmentRate);
  if (delta === null || delta < 0.08 || current.checkoutAbandonmentRate === null) return null;
  const confidence = confidenceFor(Math.min(current.checkoutStartSessions, comparison.checkoutStartSessions), 0.68);
  return storefrontRecommendation(evidence, {
    ruleId: 'checkout_abandonment_deterioration',
    category: 'CHECKOUT_ABANDONMENT',
    severity: delta >= 0.15 ? 'HIGH' : 'MEDIUM',
    title: 'Checkout abandonment increased materially',
    summary: 'A larger share of observed checkout-start sessions did not emit checkout completion than in the comparison period.',
    suggestedAction: 'Review checkout friction, payment/shipping configuration and recent storefront changes before increasing acquisition spend.',
    confidence,
    impact: Math.min(current.checkoutStartSessions / Math.max(current.sessions, 1), 1),
    urgency: clamp01(delta * 4),
    payload: { source: 'STRIDE_FIRST_PARTY_BEHAVIOR', current: current.checkoutAbandonmentRate, comparison: comparison.checkoutAbandonmentRate, changePoints: delta, checkoutStartSessions: current.checkoutStartSessions },
  });
}

export function storefrontConversionDeteriorationRule(evidence: StorefrontEvidence): RecommendationDraft | null {
  const current = evidence.current;
  const comparison = evidence.comparison;
  if (current.sessions < MIN_STORE_SESSIONS || comparison.sessions < MIN_STORE_SESSIONS) return null;
  const delta = points(current.linkedPurchaseRate, comparison.linkedPurchaseRate);
  if (delta === null || delta > -0.02 || current.linkedPurchaseRate === null) return null;
  const confidence = confidenceFor(Math.min(current.sessions, comparison.sessions));
  return storefrontRecommendation(evidence, {
    ruleId: 'storefront_conversion_deterioration',
    category: 'STOREFRONT_CONVERSION',
    severity: delta <= -0.05 ? 'HIGH' : 'MEDIUM',
    title: 'Observed storefront conversion weakened',
    summary: 'The share of observed sessions linked to valid Shopify purchases fell versus the comparison period.',
    suggestedAction: 'Inspect the largest funnel leak and the product or landing-page rows with the strongest deterioration.',
    confidence,
    impact: 0.7,
    urgency: clamp01(Math.abs(delta) * 8),
    payload: { source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS', current: current.linkedPurchaseRate, comparison: comparison.linkedPurchaseRate, changePoints: delta, sessions: current.sessions, largestFunnelDropStage: current.largestFunnelDropStage, largestFunnelDropRate: current.largestFunnelDropRate },
  });
}

export function productConversionDeteriorationRule(evidence: StorefrontDimensionEvidence): RecommendationDraft | null {
  if (evidence.entityType !== 'PRODUCT') return null;
  const current = evidence.current;
  const comparison = evidence.comparison;
  if (current.productViewSessions < MIN_PRODUCT_SESSIONS || comparison.productViewSessions < MIN_PRODUCT_SESSIONS) return null;
  const delta = points(current.linkedPurchaseRate, comparison.linkedPurchaseRate);
  if (delta === null || delta > -0.03 || current.linkedPurchaseRate === null) return null;
  const confidence = confidenceFor(Math.min(current.productViewSessions, comparison.productViewSessions), 0.6);
  return {
    ...storefrontRecommendation(evidence, {
      ruleId: 'product_conversion_deterioration',
      category: 'STOREFRONT_CONVERSION',
      severity: delta <= -0.07 ? 'HIGH' : 'MEDIUM',
      title: 'Product conversion weakened despite observed traffic',
      summary: `${evidence.name} converted a smaller share of observed sessions to linked Shopify purchases than in the comparison period.`,
      suggestedAction: 'Review product offer, merchandising and downstream cart/checkout behavior before increasing exposure.',
      confidence,
      impact: Math.min(current.productViewSessions / 1_000, 1),
      urgency: clamp01(Math.abs(delta) * 7),
      payload: { source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS', currentPurchaseRate: current.linkedPurchaseRate, comparisonPurchaseRate: comparison.linkedPurchaseRate, changePoints: delta, productViewSessions: current.productViewSessions },
    }),
    entityType: 'PRODUCT',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
  };
}

export function landingPageQualityDeteriorationRule(evidence: StorefrontDimensionEvidence): RecommendationDraft | null {
  if (evidence.entityType !== 'LANDING_PAGE') return null;
  const current = evidence.current;
  const comparison = evidence.comparison;
  if (current.sessions < MIN_LANDING_SESSIONS || comparison.sessions < MIN_LANDING_SESSIONS) return null;
  const purchaseDelta = points(current.linkedPurchaseRate, comparison.linkedPurchaseRate);
  const productViewDelta = points(current.productViewRate, comparison.productViewRate);
  const materiallyWeaker =
    (purchaseDelta !== null && purchaseDelta <= -0.025) ||
    (productViewDelta !== null && productViewDelta <= -0.1);
  if (!materiallyWeaker) return null;
  const magnitude = Math.max(Math.abs(purchaseDelta ?? 0), Math.abs(productViewDelta ?? 0));
  const confidence = confidenceFor(Math.min(current.sessions, comparison.sessions), 0.61);
  return {
    ...storefrontRecommendation(evidence, {
      ruleId: 'landing_page_quality_deterioration',
      category: 'STOREFRONT_CONVERSION',
      severity: magnitude >= 0.12 ? 'HIGH' : 'MEDIUM',
      title: 'Landing-page downstream quality weakened',
      summary: `${evidence.name} produced weaker product engagement or linked-purchase progression than in the comparison period.`,
      suggestedAction: 'Review the landing experience and traffic fit before sending more paid traffic to this route.',
      confidence,
      impact: Math.min(current.sessions / 1_500, 1),
      urgency: clamp01(magnitude * 5),
      payload: { source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS', sessions: current.sessions, currentPurchaseRate: current.linkedPurchaseRate, comparisonPurchaseRate: comparison.linkedPurchaseRate, purchaseChangePoints: purchaseDelta, productViewChangePoints: productViewDelta },
    }),
    entityType: 'STORE',
    entityId: null,
    externalEntityId: evidence.externalEntityId,
  };
}
