import type { AnalyticsListQuery, AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';
import {
  derivePixelBehaviorInsights,
  pixelBehaviorInsightChangePoints,
} from './pixel-behavior-insights.js';
import {
  pixelBehaviorService,
  type PixelBehaviorService,
} from './pixel-behavior.service.js';
import {
  pixelCheckoutPurchaseReadRepository,
  type PixelCheckoutPurchaseReadRepository,
} from './pixel-checkout-purchase.read.repository.js';

/**
 * Protocol/UI-independent Pixel read model. Keeps the derived funnel/abandonment understanding in
 * one place so first-party UI and external advisors cannot disagree about the same evidence.
 */
export class PixelBehaviorReadService {
  constructor(
    private readonly behavior: PixelBehaviorService = pixelBehaviorService,
    private readonly checkoutPurchase: PixelCheckoutPurchaseReadRepository =
      pixelCheckoutPurchaseReadRepository,
  ) {}

  async overview(storeId: string, query: AnalyticsRangeQuery) {
    const report = await this.behavior.overview(storeId, query);
    const overlap = await this.checkoutPurchase.getOverlapCounts({
      storeId,
      currentFrom: report.window.current.instantFrom,
      currentTo: report.window.current.instantTo,
      comparisonFrom: report.window.comparison.instantFrom,
      comparisonTo: report.window.comparison.instantTo,
    });
    const current = derivePixelBehaviorInsights({
      ...report.current,
      checkoutStartPurchaseSessions: overlap.current,
    });
    const comparison = derivePixelBehaviorInsights({
      ...report.comparison,
      checkoutStartPurchaseSessions: overlap.comparison,
    });

    return {
      ...report,
      understanding: {
        current: { ...current, checkoutStartPurchaseSessions: overlap.current },
        comparison: { ...comparison, checkoutStartPurchaseSessions: overlap.comparison },
        changePoints: pixelBehaviorInsightChangePoints(current, comparison),
        methodology: {
          cartAbandonment:
            'Observed cart-view sessions that did not contain a linked valid Shopify purchase.',
          checkoutAbandonment:
            'Observed checkout-start sessions that did not contain a linked non-test, non-cancelled Shopify purchase in the same materialized session.',
          largestFunnelDrop:
            'Largest valid stage-to-stage drop in the observed session funnel; non-monotonic stages are excluded rather than guessed.',
          interpretation: 'Observed behavior only; no causal explanation is implied.',
        },
      },
    };
  }

  products(storeId: string, query: AnalyticsListQuery) {
    return this.behavior.products(storeId, query);
  }

  collections(storeId: string, query: AnalyticsListQuery) {
    return this.behavior.collections(storeId, query);
  }

  landingPages(storeId: string, query: AnalyticsListQuery) {
    return this.behavior.landingPages(storeId, query);
  }
}

export const pixelBehaviorReadService = new PixelBehaviorReadService();
