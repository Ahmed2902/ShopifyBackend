import {
  derivePixelBehaviorInsights,
  type PixelBehaviorInsightInput,
} from '../pixel/behavior/pixel-behavior-insights.js';
import type {
  StorefrontBehaviorPeriod,
  StorefrontDimensionEvidence,
  StorefrontEvidence,
} from './storefront-intelligence.types.js';

type BehaviorMetrics = PixelBehaviorInsightInput & {
  productViewRate: number | null;
  viewToCartRate: number | null;
  cartViewToCheckoutRate?: number | null;
  cartViewToPurchaseRate?: number | null;
  linkedPurchaseRate: number | null;
};

type Quality = {
  state: 'READY' | 'DEGRADED' | 'NOT_READY';
  limitations: string[];
};

function limitations(quality: Quality) {
  return quality.limitations.map((code) => ({
    code,
    message: 'Stride Pixel behavior evidence is currently degraded; interpret storefront findings with caution.',
  }));
}

function qualityFor(quality: Quality, support: number): StorefrontEvidence['evidenceQuality'] {
  if (quality.state === 'DEGRADED') return 'LOW';
  if (support >= 2_000) return 'HIGH';
  if (support >= 500) return 'MEDIUM';
  return 'LOW';
}

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
  quality: Quality;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): StorefrontEvidence | null {
  if (input.quality.state === 'NOT_READY') return null;
  const current = storefrontBehaviorPeriod(input.current);
  const comparison = storefrontBehaviorPeriod(input.comparison);
  return {
    current,
    comparison,
    evidenceQuality: qualityFor(input.quality, Math.min(current.sessions, comparison.sessions)),
    limitations: limitations(input.quality),
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
  };
}

export function buildStorefrontDimensionEvidence(input: {
  entityType: 'PRODUCT' | 'LANDING_PAGE';
  entityId: string | null;
  externalEntityId: string | null;
  name: string;
  current: BehaviorMetrics;
  comparison: BehaviorMetrics;
  quality: Quality;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): StorefrontDimensionEvidence | null {
  const base = buildStorefrontEvidence(input);
  if (!base) return null;
  return {
    ...base,
    entityType: input.entityType,
    entityId: input.entityId,
    externalEntityId: input.externalEntityId,
    name: input.name,
  };
}
