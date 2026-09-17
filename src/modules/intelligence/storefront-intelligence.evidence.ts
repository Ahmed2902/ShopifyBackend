import type { StorefrontBehaviorPeriod, StorefrontEvidence } from './storefront-intelligence.types.js';

type BehaviorMetrics = {
  sessions: number;
  productViewSessions: number;
  addToCartSessions: number;
  cartViewSessions: number;
  cartViewCheckoutSessions?: number;
  cartViewPurchaseSessions?: number;
  checkoutStartSessions: number;
  checkoutCompletedSessions: number;
  linkedPurchaseSessions: number;
  productViewRate: number | null;
  viewToCartRate: number | null;
  cartViewToCheckoutRate?: number | null;
  cartViewToPurchaseRate?: number | null;
  linkedPurchaseRate: number | null;
};

function safeRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function complement(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(1, 1 - value));
}

function stageDrop(numerator: number, denominator: number): number | null {
  if (denominator <= 0 || numerator < 0 || numerator > denominator) return null;
  return 1 - numerator / denominator;
}

export function storefrontBehaviorPeriod(metrics: BehaviorMetrics): StorefrontBehaviorPeriod {
  const cartViewToCheckoutRate = metrics.cartViewToCheckoutRate ?? safeRate(metrics.cartViewCheckoutSessions ?? 0, metrics.cartViewSessions);
  const cartViewToPurchaseRate = metrics.cartViewToPurchaseRate ?? safeRate(metrics.cartViewPurchaseSessions ?? 0, metrics.cartViewSessions);
  const checkoutCompletionRate = safeRate(metrics.checkoutCompletedSessions, metrics.checkoutStartSessions);
  const candidates: Array<[StorefrontBehaviorPeriod['largestFunnelDropStage'], number | null]> = [
    ['SESSION_TO_PRODUCT', stageDrop(metrics.productViewSessions, metrics.sessions)],
    ['PRODUCT_TO_CART', stageDrop(metrics.addToCartSessions, metrics.productViewSessions)],
    ['CART_TO_CHECKOUT', stageDrop(metrics.checkoutStartSessions, metrics.addToCartSessions)],
    ['CHECKOUT_TO_PURCHASE', stageDrop(metrics.linkedPurchaseSessions, metrics.checkoutStartSessions)],
  ];
  const available = candidates.filter((entry): entry is [Exclude<StorefrontBehaviorPeriod['largestFunnelDropStage'], null>, number] => entry[0] !== null && entry[1] !== null);
  available.sort((left, right) => right[1] - left[1]);
  const largest = available[0] ?? null;

  return {
    sessions: metrics.sessions,
    productViewSessions: metrics.productViewSessions,
    addToCartSessions: metrics.addToCartSessions,
    cartViewSessions: metrics.cartViewSessions,
    cartViewCheckoutSessions: metrics.cartViewCheckoutSessions ?? 0,
    cartViewPurchaseSessions: metrics.cartViewPurchaseSessions ?? 0,
    checkoutStartSessions: metrics.checkoutStartSessions,
    linkedPurchaseSessions: metrics.linkedPurchaseSessions,
    productViewRate: metrics.productViewRate,
    viewToCartRate: metrics.viewToCartRate,
    cartViewToCheckoutRate,
    cartViewToPurchaseRate,
    cartAbandonmentRate: complement(cartViewToPurchaseRate),
    checkoutCompletionRate,
    checkoutAbandonmentRate: complement(checkoutCompletionRate),
    linkedPurchaseRate: metrics.linkedPurchaseRate,
    largestFunnelDropStage: largest?.[0] ?? null,
    largestFunnelDropRate: largest?.[1] ?? null,
  };
}

export function buildStorefrontEvidence(input: {
  current: BehaviorMetrics;
  comparison: BehaviorMetrics;
  quality: { state: 'READY' | 'DEGRADED' | 'NOT_READY'; limitations: string[] };
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): StorefrontEvidence | null {
  if (input.quality.state === 'NOT_READY') return null;
  const current = storefrontBehaviorPeriod(input.current);
  const comparison = storefrontBehaviorPeriod(input.comparison);
  const support = Math.min(current.sessions, comparison.sessions);
  const evidenceQuality = input.quality.state === 'DEGRADED'
    ? 'LOW'
    : support >= 2_000
      ? 'HIGH'
      : support >= 500
        ? 'MEDIUM'
        : 'LOW';
  return {
    current,
    comparison,
    evidenceQuality,
    limitations: input.quality.limitations.map((code) => ({
      code,
      message: 'Stride Pixel behavior evidence is currently degraded; interpret storefront findings with caution.',
    })),
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
  };
}
