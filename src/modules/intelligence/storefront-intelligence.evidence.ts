import {
  derivePixelBehaviorInsights,
  type PixelBehaviorInsightInput,
} from '../pixel/behavior/pixel-behavior-insights.js';
import type { StorefrontBehaviorPeriod, StorefrontEvidence } from './storefront-intelligence.types.js';

type BehaviorMetrics = PixelBehaviorInsightInput & {
  productViewRate: number | null;
  viewToCartRate: number | null;
  cartViewToCheckoutRate?: number | null;
  cartViewToPurchaseRate?: number | null;
  linkedPurchaseRate: number | null;
};

export function storefrontBehaviorPeriod(metrics: BehaviorMetrics): StorefrontBehaviorPeriod {
  const insights = derivePixelBehaviorInsights(metrics);
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
    cartViewToCheckoutRate:
      metrics.cartViewToCheckoutRate ??
      (metrics.cartViewSessions > 0
        ? (metrics.cartViewCheckoutSessions ?? 0) / metrics.cartViewSessions
        : null),
    cartViewToPurchaseRate:
      metrics.cartViewToPurchaseRate ??
      (metrics.cartViewSessions > 0
        ? (metrics.cartViewPurchaseSessions ?? 0) / metrics.cartViewSessions
        : null),
    linkedPurchaseRate: metrics.linkedPurchaseRate,
    ...insights,
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
