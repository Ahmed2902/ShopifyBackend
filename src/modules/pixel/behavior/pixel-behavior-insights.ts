export type StorefrontFunnelDropStage =
  | 'SESSION_TO_PRODUCT'
  | 'PRODUCT_TO_CART'
  | 'CART_TO_CHECKOUT'
  | 'CHECKOUT_TO_PURCHASE';

export interface PixelBehaviorInsightInput {
  sessions: number;
  productViewSessions: number;
  addToCartSessions: number;
  cartViewSessions: number;
  cartViewCheckoutSessions?: number;
  cartViewPurchaseSessions?: number;
  checkoutStartSessions: number;
  checkoutCompletedSessions: number;
  linkedPurchaseSessions: number;
  cartViewToCheckoutRate?: number | null;
  cartViewToPurchaseRate?: number | null;
}

export interface PixelBehaviorInsights {
  cartAbandonmentRate: number | null;
  checkoutCompletionRate: number | null;
  checkoutAbandonmentRate: number | null;
  largestFunnelDropStage: StorefrontFunnelDropStage | null;
  largestFunnelDropRate: number | null;
}

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

export function derivePixelBehaviorInsights(metrics: PixelBehaviorInsightInput): PixelBehaviorInsights {
  const cartViewToPurchaseRate =
    metrics.cartViewToPurchaseRate ??
    safeRate(metrics.cartViewPurchaseSessions ?? 0, metrics.cartViewSessions);
  const checkoutCompletionRate = safeRate(
    metrics.checkoutCompletedSessions,
    metrics.checkoutStartSessions,
  );
  const candidates: Array<[StorefrontFunnelDropStage, number | null]> = [
    ['SESSION_TO_PRODUCT', stageDrop(metrics.productViewSessions, metrics.sessions)],
    ['PRODUCT_TO_CART', stageDrop(metrics.addToCartSessions, metrics.productViewSessions)],
    ['CART_TO_CHECKOUT', stageDrop(metrics.checkoutStartSessions, metrics.addToCartSessions)],
    ['CHECKOUT_TO_PURCHASE', stageDrop(metrics.linkedPurchaseSessions, metrics.checkoutStartSessions)],
  ];
  const available = candidates.filter(
    (entry): entry is [StorefrontFunnelDropStage, number] => entry[1] !== null,
  );
  available.sort((left, right) => right[1] - left[1]);
  const largest = available[0] ?? null;

  return {
    cartAbandonmentRate: complement(cartViewToPurchaseRate),
    checkoutCompletionRate,
    checkoutAbandonmentRate: complement(checkoutCompletionRate),
    largestFunnelDropStage: largest?.[0] ?? null,
    largestFunnelDropRate: largest?.[1] ?? null,
  };
}

export function pixelBehaviorInsightChangePoints(
  current: PixelBehaviorInsights,
  comparison: PixelBehaviorInsights,
) {
  const points = (left: number | null, right: number | null) =>
    left === null || right === null ? null : left - right;
  return {
    cartAbandonmentRate: points(current.cartAbandonmentRate, comparison.cartAbandonmentRate),
    checkoutCompletionRate: points(current.checkoutCompletionRate, comparison.checkoutCompletionRate),
    checkoutAbandonmentRate: points(current.checkoutAbandonmentRate, comparison.checkoutAbandonmentRate),
    largestFunnelDropRate:
      current.largestFunnelDropStage === comparison.largestFunnelDropStage
        ? points(current.largestFunnelDropRate, comparison.largestFunnelDropRate)
        : null,
  };
}
