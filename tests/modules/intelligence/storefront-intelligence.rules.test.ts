import { describe, expect, it } from 'vitest';
import {
  cartAbandonmentDeteriorationRule,
  checkoutAbandonmentDeteriorationRule,
  storefrontConversionDeteriorationRule,
} from '../../../src/modules/intelligence/storefront-intelligence.rules.js';
import type { StorefrontEvidence } from '../../../src/modules/intelligence/storefront-intelligence.types.js';

function evidence(): StorefrontEvidence {
  return {
    evidenceQuality: 'HIGH',
    limitations: [],
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-07T23:59:59.999Z'),
    comparisonStart: new Date('2026-08-25T00:00:00.000Z'),
    comparisonEnd: new Date('2026-08-31T23:59:59.999Z'),
    current: {
      sessions: 2_000,
      productViewSessions: 1_500,
      addToCartSessions: 500,
      cartViewSessions: 400,
      cartViewCheckoutSessions: 240,
      cartViewPurchaseSessions: 160,
      checkoutStartSessions: 300,
      checkoutStartPurchaseSessions: 170,
      linkedPurchaseSessions: 180,
      productViewRate: 0.75,
      viewToCartRate: 1 / 3,
      cartViewToCheckoutRate: 0.6,
      cartViewToPurchaseRate: 0.4,
      cartAbandonmentRate: 0.6,
      checkoutCompletionRate: 170 / 300,
      checkoutAbandonmentRate: 130 / 300,
      linkedPurchaseRate: 0.09,
      largestFunnelDropStage: 'PRODUCT_TO_CART',
      largestFunnelDropRate: 2 / 3,
    },
    comparison: {
      sessions: 2_000,
      productViewSessions: 1_500,
      addToCartSessions: 600,
      cartViewSessions: 400,
      cartViewCheckoutSessions: 300,
      cartViewPurchaseSessions: 240,
      checkoutStartSessions: 350,
      checkoutStartPurchaseSessions: 245,
      linkedPurchaseSessions: 260,
      productViewRate: 0.75,
      viewToCartRate: 0.4,
      cartViewToCheckoutRate: 0.75,
      cartViewToPurchaseRate: 0.6,
      cartAbandonmentRate: 0.4,
      checkoutCompletionRate: 0.7,
      checkoutAbandonmentRate: 0.3,
      linkedPurchaseRate: 0.13,
      largestFunnelDropStage: 'PRODUCT_TO_CART',
      largestFunnelDropRate: 0.6,
    },
  };
}

describe('storefront intelligence rules', () => {
  it('flags cart abandonment deterioration', () => {
    expect(cartAbandonmentDeteriorationRule(evidence())?.ruleId).toBe('cart_abandonment_deterioration');
  });

  it('flags checkout abandonment deterioration', () => {
    expect(checkoutAbandonmentDeteriorationRule(evidence())?.ruleId).toBe('checkout_abandonment_deterioration');
  });

  it('flags storefront purchase-rate deterioration', () => {
    expect(storefrontConversionDeteriorationRule(evidence())?.ruleId).toBe('storefront_conversion_deterioration');
  });

  it('suppresses low-volume funnel diagnoses', () => {
    const input = evidence();
    input.current.cartViewSessions = 20;
    expect(cartAbandonmentDeteriorationRule(input)).toBeNull();
  });
});
