import { describe, expect, it } from 'vitest';
import { storefrontEventSchema } from '../../../src/modules/pixel/pixel.schema.js';

const base = {
  eventId: 'event_checkout_001',
  eventAt: '2026-09-04T14:10:00.000Z',
  consentState: 'GRANTED' as const,
};

describe('Stride Pixel checkout linkage contract', () => {
  it('accepts Shopify checkout token and order id only on checkout completion evidence', () => {
    expect(
      storefrontEventSchema.parse({
        ...base,
        eventName: 'CHECKOUT_COMPLETED',
        shopifyCheckoutToken: 'checkout-token-1',
        shopifyOrderExternalId: 'gid://shopify/Order/9000',
      }),
    ).toMatchObject({
      shopifyCheckoutToken: 'checkout-token-1',
      shopifyOrderExternalId: 'gid://shopify/Order/9000',
    });
  });

  it('rejects order identity on non-completion events', () => {
    expect(() =>
      storefrontEventSchema.parse({
        ...base,
        eventName: 'PAGE_VIEW',
        shopifyOrderExternalId: 'gid://shopify/Order/9000',
      }),
    ).toThrow();
  });

  it('rejects checkout tokens on unrelated storefront events', () => {
    expect(() =>
      storefrontEventSchema.parse({
        ...base,
        eventName: 'PRODUCT_VIEW',
        productExternalId: 'gid://shopify/Product/1',
        shopifyCheckoutToken: 'checkout-token-1',
      }),
    ).toThrow();
  });
});
