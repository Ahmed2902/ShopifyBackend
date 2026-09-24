import type { AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';
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
 * Protocol-independent storefront overview used by both HTTP and advisor/MCP reads.
 *
 * Keep derived behavior understanding here so every consumer uses the exact same
 * Stride formulas and Shopify-linked purchase semantics.
 */
export class PixelBehaviorOverviewReadService {
  constructor(
    private readonly behavior: PixelBehaviorService = pixelBehaviorService,
    private readonly checkoutPurchaseReads: PixelCheckoutPurchaseReadRepository =
      pixelCheckoutPurchaseReadRepository,
  ) {}

  async read(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const report = await this.behavior.overview(storeId, query, now);
    const checkoutPurchase = await this.checkoutPurchaseReads.getOverlapCounts({
      storeId,
      currentFrom: report.window.current.instantFrom,
      currentTo: report.window.current.instantTo,
      comparisonFrom: report.window.comparison.instantFrom,
      comparisonTo: report.window.comparison.instantTo,
    });
    const current = derivePixelBehaviorInsights({
      ...report.current,
      checkoutStartPurchaseSessions: checkoutPurchase.current,
    });
    const comparison = derivePixelBehaviorInsights({
      ...report.comparison,
      checkoutStartPurchaseSessions: checkoutPurchase.comparison,
    });

    return {
      ...report,
      understanding: {
        current: {
          ...current,
          checkoutStartPurchaseSessions: checkoutPurchase.current,
        },
        comparison: {
          ...comparison,
          checkoutStartPurchaseSessions: checkoutPurchase.comparison,
        },
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
}

export const pixelBehaviorOverviewReadService = new PixelBehaviorOverviewReadService();
