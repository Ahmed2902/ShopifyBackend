import { describe, expect, it } from 'vitest';
import {
  derivePixelBehaviorInsights,
  pixelBehaviorInsightChangePoints,
} from '../../../src/modules/pixel/behavior/pixel-behavior-insights.js';

function input(overrides: Partial<Parameters<typeof derivePixelBehaviorInsights>[0]> = {}) {
  return {
    sessions: 1_000,
    productViewSessions: 700,
    addToCartSessions: 210,
    cartViewSessions: 180,
    cartViewCheckoutSessions: 120,
    cartViewPurchaseSessions: 72,
    checkoutStartSessions: 140,
    checkoutStartPurchaseSessions: 70,
    ...overrides,
  };
}

describe('pixel behavior insights', () => {
  it('uses linked Shopify purchase overlap for checkout abandonment', () => {
    const result = derivePixelBehaviorInsights(
      input({ checkoutStartSessions: 100, checkoutStartPurchaseSessions: 55 }),
    );

    expect(result.checkoutCompletionRate).toBe(0.55);
    expect(result.checkoutAbandonmentRate).toBe(0.45);
  });

  it('derives cart abandonment from same-session cart-view purchase overlap', () => {
    const result = derivePixelBehaviorInsights(
      input({ cartViewSessions: 100, cartViewPurchaseSessions: 42 }),
    );

    expect(result.cartAbandonmentRate).toBe(0.58);
  });

  it('identifies the largest valid funnel drop without inventing non-monotonic rates', () => {
    const result = derivePixelBehaviorInsights(
      input({
        sessions: 1_000,
        productViewSessions: 800,
        addToCartSessions: 400,
        cartViewSessions: 300,
        cartViewCheckoutSessions: 240,
        checkoutStartSessions: 200,
        checkoutStartPurchaseSessions: 50,
      }),
    );

    expect(result.largestFunnelDropStage).toBe('CHECKOUT_TO_PURCHASE');
    expect(result.largestFunnelDropRate).toBe(0.75);
  });

  it('excludes a non-monotonic stage instead of manufacturing a negative drop', () => {
    const result = derivePixelBehaviorInsights(
      input({
        sessions: 100,
        productViewSessions: 120,
        addToCartSessions: 30,
        cartViewSessions: 20,
        cartViewCheckoutSessions: 10,
        checkoutStartSessions: 10,
        checkoutStartPurchaseSessions: 8,
      }),
    );

    expect(result.largestFunnelDropRate).toBeGreaterThanOrEqual(0);
    expect(result.largestFunnelDropStage).not.toBe('SESSION_TO_PRODUCT');
  });

  it('reports percentage-point movement for stable leak stages', () => {
    const current = derivePixelBehaviorInsights(
      input({ checkoutStartSessions: 100, checkoutStartPurchaseSessions: 50 }),
    );
    const comparison = derivePixelBehaviorInsights(
      input({ checkoutStartSessions: 100, checkoutStartPurchaseSessions: 70 }),
    );

    expect(pixelBehaviorInsightChangePoints(current, comparison)).toMatchObject({
      checkoutCompletionRate: -0.2,
      checkoutAbandonmentRate: 0.2,
    });
  });
});
