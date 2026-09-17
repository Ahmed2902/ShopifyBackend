import { describe, expect, it } from 'vitest';
import { buildStorefrontEvidence } from '../../../src/modules/intelligence/storefront-intelligence.metrics.js';
import {
  cartAbandonmentDeteriorationRule,
  checkoutAbandonmentDeteriorationRule,
  highTrafficLowConversionRule,
  storefrontConversionDeteriorationRule,
  viewToCartDeteriorationRule,
} from '../../../src/modules/intelligence/storefront-intelligence.rules.js';

const window = {
  start: new Date('2026-09-08T00:00:00.000Z'),
  end: new Date('2026-09-14T23:59:59.999Z'),
  comparisonStart: new Date('2026-09-01T00:00:00.000Z'),
  comparisonEnd: new Date('2026-09-07T23:59:59.999Z'),
};

function metrics(overrides: Record<string, number | null> = {}) {
  return {
    sessions: 1_000,
    productViewSessions: 700,
    addToCartSessions: 140,
    cartViewSessions: 120,
    cartViewCheckoutSessions: 90,
    cartViewPurchaseSessions: 60,
    checkoutStartSessions: 100,
    checkoutCompletedSessions: 70,
    linkedPurchaseSessions: 60,
    productViewRate: 0.7,
    viewToCartRate: 0.2,
    cartViewToCheckoutRate: 0.75,
    cartViewToPurchaseRate: 0.5,
    linkedPurchaseRate: 0.06,
    ...overrides,
  };
}

function evidence(input: {
  entityType?: 'STORE' | 'PRODUCT' | 'LANDING_PAGE';
  current?: Record<string, number | null>;
  comparison?: Record<string, number | null>;
}) {
  return buildStorefrontEvidence({
    entityType: input.entityType ?? 'STORE',
    entityId: input.entityType === 'PRODUCT' ? 'product-1' : null,
    externalEntityId: input.entityType === 'LANDING_PAGE' ? 'landing-hash' : null,
    name: input.entityType === 'PRODUCT' ? 'Hero product' : input.entityType === 'LANDING_PAGE' ? '/collections/summer' : 'Storefront',
    current: metrics(input.current),
    comparison: metrics(input.comparison),
    quality: { state: 'READY', limitations: [] },
  });
}

describe('storefront intelligence rules', () => {
  it('flags material cart abandonment deterioration using overlapping cart-view purchases', () => {
    const result = cartAbandonmentDeteriorationRule(
      evidence({
        current: { cartViewSessions: 200, cartViewPurchaseSessions: 70, cartViewToPurchaseRate: 0.35 },
        comparison: { cartViewSessions: 180, cartViewPurchaseSessions: 108, cartViewToPurchaseRate: 0.6 },
      }),
      window,
    );

    expect(result).toMatchObject({
      ruleId: 'cart_abandonment_deterioration',
      category: 'CART_ABANDONMENT',
      entityType: 'STORE',
    });
    expect(result?.evidence).toMatchObject({ cartAbandonmentRatePoints: 0.25 });
  });

  it('uses observed checkout completion for checkout abandonment', () => {
    const result = checkoutAbandonmentDeteriorationRule(
      evidence({
        current: { checkoutStartSessions: 120, checkoutCompletedSessions: 60 },
        comparison: { checkoutStartSessions: 100, checkoutCompletedSessions: 80 },
      }),
      window,
    );

    expect(result).toMatchObject({
      ruleId: 'checkout_abandonment_deterioration',
      category: 'CHECKOUT_ABANDONMENT',
      severity: 'HIGH',
    });
  });

  it('flags store purchase conversion deterioration only with adequate support', () => {
    const result = storefrontConversionDeteriorationRule(
      evidence({ current: { linkedPurchaseSessions: 30, linkedPurchaseRate: 0.03 } }),
      window,
    );

    expect(result?.ruleId).toBe('storefront_conversion_deterioration');
  });

  it('flags product view-to-cart deterioration', () => {
    const result = viewToCartDeteriorationRule(
      evidence({
        entityType: 'PRODUCT',
        current: { productViewSessions: 300, addToCartSessions: 30, viewToCartRate: 0.1 },
        comparison: { productViewSessions: 280, addToCartSessions: 56, viewToCartRate: 0.2 },
      }),
      window,
    );

    expect(result).toMatchObject({
      ruleId: 'product_view_to_cart_deterioration',
      category: 'PRODUCT_CONVERSION',
      entityType: 'PRODUCT',
    });
  });

  it('flags high-traffic low-conversion landing pages without claiming a cause', () => {
    const result = highTrafficLowConversionRule(
      evidence({
        entityType: 'LANDING_PAGE',
        current: { sessions: 600, linkedPurchaseSessions: 3, linkedPurchaseRate: 0.005 },
      }),
      window,
    );

    expect(result).toMatchObject({
      ruleId: 'high_traffic_low_conversion_landing_page',
      category: 'LANDING_PAGE_QUALITY',
      entityType: 'LANDING_PAGE',
    });
    expect(result?.evidence).toMatchObject({ interpretation: 'OBSERVED_BEHAVIOR_NOT_CAUSAL_DIAGNOSIS' });
  });

  it('suppresses decisions when Pixel rollups are not ready', () => {
    const notReady = buildStorefrontEvidence({
      entityType: 'STORE',
      entityId: null,
      name: 'Storefront',
      current: metrics({ cartViewToPurchaseRate: 0.2 }),
      comparison: metrics({ cartViewToPurchaseRate: 0.8 }),
      quality: { state: 'NOT_READY', limitations: ['PIXEL_ANALYTICS_NOT_ROLLED_UP'] },
    });

    expect(cartAbandonmentDeteriorationRule(notReady, window)).toBeNull();
    expect(checkoutAbandonmentDeteriorationRule(notReady, window)).toBeNull();
  });
});
