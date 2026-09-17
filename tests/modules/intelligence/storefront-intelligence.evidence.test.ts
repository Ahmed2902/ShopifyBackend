import { describe, expect, it } from 'vitest';
import { storefrontBehaviorPeriod } from '../../../src/modules/intelligence/storefront-intelligence.evidence.js';

describe('storefrontBehaviorPeriod', () => {
  it('derives abandonment and the largest observed funnel leak', () => {
    const result = storefrontBehaviorPeriod({
      sessions: 1_000,
      productViewSessions: 800,
      addToCartSessions: 200,
      cartViewSessions: 180,
      cartViewCheckoutSessions: 120,
      cartViewPurchaseSessions: 90,
      checkoutStartSessions: 150,
      checkoutCompletedSessions: 105,
      linkedPurchaseSessions: 100,
      productViewRate: 0.8,
      viewToCartRate: 0.25,
      cartViewToCheckoutRate: 2 / 3,
      cartViewToPurchaseRate: 0.5,
      linkedPurchaseRate: 0.1,
    });

    expect(result.cartAbandonmentRate).toBeCloseTo(0.5);
    expect(result.checkoutCompletionRate).toBeCloseTo(0.7);
    expect(result.checkoutAbandonmentRate).toBeCloseTo(0.3);
    expect(result.largestFunnelDropStage).toBe('PRODUCT_TO_CART');
    expect(result.largestFunnelDropRate).toBeCloseTo(0.75);
  });

  it('does not invent a stage rate when stage counts are non-monotonic', () => {
    const result = storefrontBehaviorPeriod({
      sessions: 10,
      productViewSessions: 12,
      addToCartSessions: 3,
      cartViewSessions: 0,
      checkoutStartSessions: 0,
      checkoutCompletedSessions: 0,
      linkedPurchaseSessions: 0,
      productViewRate: null,
      viewToCartRate: null,
      linkedPurchaseRate: 0,
    });
    expect(result.cartAbandonmentRate).toBeNull();
  });
});
