import { describe, expect, it } from 'vitest';
import {
  cartAbandonmentDeteriorationRule,
  checkoutAbandonmentDeteriorationRule,
  landingPageQualityDeteriorationRule,
  productConversionDeteriorationRule,
  storefrontConversionDeteriorationRule,
  viewToCartDeteriorationRule,
} from '../../../src/modules/intelligence/storefront-intelligence.rules.js';
import type {
  StorefrontBehaviorEvidence,
  StorefrontBehaviorMetrics,
} from '../../../src/modules/intelligence/intelligence.types.js';

const window = {
  currentStart: new Date('2026-09-01T00:00:00.000Z'),
  currentEnd: new Date('2026-09-07T23:59:59.999Z'),
  comparisonStart: new Date('2026-08-25T00:00:00.000Z'),
  comparisonEnd: new Date('2026-08-31T23:59:59.999Z'),
};

function metrics(overrides: Partial<StorefrontBehaviorMetrics> = {}): StorefrontBehaviorMetrics {
  return {
    sessions: 500,
    productViewSessions: 350,
    addToCartSessions: 70,
    cartViewSessions: 60,
    cartViewCheckoutSessions: 40,
    cartViewPurchaseSessions: 30,
    checkoutStartSessions: 55,
    checkoutCompletedSessions: 40,
    linkedPurchaseSessions: 35,
    productViewRate: 0.7,
    viewToCartRate: 0.2,
    cartViewToCheckoutRate: 0.667,
    cartViewToPurchaseRate: 0.5,
    cartAbandonmentRate: 0.5,
    checkoutCompletionRate: 0.727,
    checkoutAbandonmentRate: 0.273,
    linkedPurchaseRate: 0.07,
    ...overrides,
  };
}

function evidence(
  dimension: StorefrontBehaviorEvidence['dimension'] = 'STORE',
  current: Partial<StorefrontBehaviorMetrics> = {},
  comparison: Partial<StorefrontBehaviorMetrics> = {},
): StorefrontBehaviorEvidence {
  return {
    dimension,
    entityId: dimension === 'PRODUCT' ? 'product-1' : null,
    externalEntityId: dimension === 'PRODUCT' ? 'gid://shopify/Product/1' : null,
    name: dimension === 'PRODUCT' ? 'Hero product' : dimension === 'LANDING_PAGE' ? '/collections/new' : 'Storefront',
    current: metrics(current),
    comparison: metrics(comparison),
    sourceRowCount: 14,
  };
}

describe('storefront intelligence rules', () => {
  it('flags material cart abandonment deterioration', () => {
    const result = cartAbandonmentDeteriorationRule(
      evidence('STORE', { cartAbandonmentRate: 0.64 }, { cartAbandonmentRate: 0.46 }),
      window,
    );
    expect(result).toMatchObject({ ruleId: 'cart_abandonment_deterioration', category: 'STOREFRONT_FUNNEL' });
  });

  it('flags checkout completion deterioration', () => {
    const result = checkoutAbandonmentDeteriorationRule(
      evidence('STORE', { checkoutAbandonmentRate: 0.46 }, { checkoutAbandonmentRate: 0.28 }),
      window,
    );
    expect(result).toMatchObject({ ruleId: 'checkout_abandonment_deterioration' });
  });

  it('flags view-to-cart deterioration only with meaningful relative decline', () => {
    const result = viewToCartDeteriorationRule(
      evidence('STORE', { viewToCartRate: 0.11 }, { viewToCartRate: 0.2 }),
      window,
    );
    expect(result).toMatchObject({ ruleId: 'view_to_cart_deterioration' });
  });

  it('flags storefront purchase conversion deterioration', () => {
    const result = storefrontConversionDeteriorationRule(
      evidence('STORE', { linkedPurchaseRate: 0.045 }, { linkedPurchaseRate: 0.07 }),
      window,
    );
    expect(result).toMatchObject({ ruleId: 'storefront_conversion_deterioration' });
  });

  it('flags product and landing-page conversion deterioration', () => {
    expect(
      productConversionDeteriorationRule(
        evidence('PRODUCT', { linkedPurchaseRate: 0.025 }, { linkedPurchaseRate: 0.05 }),
        window,
      ),
    ).toMatchObject({ ruleId: 'product_conversion_deterioration', entityType: 'PRODUCT' });
    expect(
      landingPageQualityDeteriorationRule(
        evidence('LANDING_PAGE', { linkedPurchaseRate: 0.02 }, { linkedPurchaseRate: 0.05 }),
        window,
      ),
    ).toMatchObject({ ruleId: 'landing_page_quality_deterioration', entityType: 'LANDING_PAGE' });
  });

  it('suppresses thin samples', () => {
    const result = cartAbandonmentDeteriorationRule(
      evidence(
        'STORE',
        { cartViewSessions: 10, cartAbandonmentRate: 0.8 },
        { cartViewSessions: 10, cartAbandonmentRate: 0.4 },
      ),
      window,
    );
    expect(result).toBeNull();
  });
});
