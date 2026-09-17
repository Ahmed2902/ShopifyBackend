import type { StorefrontEvidence, StorefrontFunnelMetrics } from './intelligence.types.js';

type PixelMetrics = {
  sessions: number;
  productViewSessions: number;
  addToCartSessions: number;
  cartViewSessions?: number;
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

type PixelQuality = {
  state: 'READY' | 'DEGRADED' | 'NOT_READY';
  limitations: string[];
};

function safeRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function funnel(metrics: PixelMetrics): StorefrontFunnelMetrics {
  const cartViewSessions = metrics.cartViewSessions ?? 0;
  const cartViewCheckoutSessions = metrics.cartViewCheckoutSessions ?? 0;
  const cartViewPurchaseSessions = metrics.cartViewPurchaseSessions ?? 0;
  const checkoutCompletionRate = safeRate(
    metrics.checkoutCompletedSessions,
    metrics.checkoutStartSessions,
  );
  const cartViewToPurchaseRate = metrics.cartViewToPurchaseRate ??
    safeRate(cartViewPurchaseSessions, cartViewSessions);

  return {
    sessions: metrics.sessions,
    productViewSessions: metrics.productViewSessions,
    addToCartSessions: metrics.addToCartSessions,
    cartViewSessions,
    cartViewCheckoutSessions,
    cartViewPurchaseSessions,
    checkoutStartSessions: metrics.checkoutStartSessions,
    checkoutCompletedSessions: metrics.checkoutCompletedSessions,
    linkedPurchaseSessions: metrics.linkedPurchaseSessions,
    productViewRate: metrics.productViewRate,
    viewToCartRate: metrics.viewToCartRate,
    cartViewToCheckoutRate: metrics.cartViewToCheckoutRate ?? safeRate(cartViewCheckoutSessions, cartViewSessions),
    cartViewToPurchaseRate,
    cartViewAbandonmentRate: cartViewToPurchaseRate === null ? null : 1 - cartViewToPurchaseRate,
    checkoutCompletionRate,
    checkoutAbandonmentRate: checkoutCompletionRate === null ? null : 1 - checkoutCompletionRate,
    linkedPurchaseRate: metrics.linkedPurchaseRate,
  };
}

export function buildStorefrontEvidence(input: {
  entityType: StorefrontEvidence['entityType'];
  entityId: string | null;
  externalEntityId?: string | null;
  name: string;
  current: PixelMetrics;
  comparison: PixelMetrics;
  quality: PixelQuality;
}): StorefrontEvidence {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    externalEntityId: input.externalEntityId ?? null,
    name: input.name,
    current: funnel(input.current),
    comparison: funnel(input.comparison),
    qualityState: input.quality.state,
    limitations: input.quality.limitations,
  };
}
