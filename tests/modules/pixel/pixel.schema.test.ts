import { describe, expect, it } from 'vitest';
import { storefrontEventSchema } from '../../../src/modules/pixel/pixel.schema.js';

const baseEvent = {
  eventId: 'evt_12345678',
  eventName: 'PAGE_VIEW' as const,
  eventAt: '2026-09-04T12:00:00.000Z',
  consentState: 'GRANTED' as const,
  pageUrl: 'https://store.example/products/shirt',
};

describe('Stride Pixel event schema', () => {
  it('accepts the privacy-minimized V1 event contract and defaults its version', () => {
    expect(
      storefrontEventSchema.parse({
        ...baseEvent,
        anonymousVisitorId: 'visitor_12345678',
        sessionId: 'session_12345678',
        attribution: {
          utmSource: 'meta',
          utmCampaign: 'summer-drop',
          metaClickId: 'fbclid-123',
        },
      }),
    ).toMatchObject({
      eventVersion: 1,
      eventName: 'PAGE_VIEW',
      consentState: 'GRANTED',
    });
  });

  it('rejects unexpected fields so raw PII cannot silently enter the collector contract', () => {
    expect(() =>
      storefrontEventSchema.parse({
        ...baseEvent,
        email: 'customer@example.com',
      }),
    ).toThrow();
  });

  it('requires a product or variant identity for product and cart events', () => {
    expect(() =>
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'PRODUCT_VIEW',
      }),
    ).toThrow();

    expect(() =>
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'ADD_TO_CART',
        quantity: 2,
      }),
    ).toThrow();

    expect(
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'ADD_TO_CART',
        variantExternalId: 'gid://shopify/ProductVariant/123',
        quantity: 2,
      }),
    ).toMatchObject({
      eventName: 'ADD_TO_CART',
      quantity: 2,
    });
  });

  it('canonicalizes numeric Shopify storefront identities to Admin API GIDs', () => {
    expect(
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'PRODUCT_VIEW',
        productExternalId: '9112852627610',
        variantExternalId: '49055178915994',
      }),
    ).toMatchObject({
      productExternalId: 'gid://shopify/Product/9112852627610',
      variantExternalId: 'gid://shopify/ProductVariant/49055178915994',
    });

    expect(
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'CHECKOUT_COMPLETED',
        shopifyOrderExternalId: '1234567890',
      }),
    ).toMatchObject({
      shopifyOrderExternalId: 'gid://shopify/Order/1234567890',
    });
  });

  it('enforces database length limits after Shopify IDs are canonicalized', () => {
    const oversizedNumericId = '9'.repeat(128);

    expect(() =>
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'PRODUCT_VIEW',
        productExternalId: oversizedNumericId,
      }),
    ).toThrow();

    expect(() =>
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'CHECKOUT_COMPLETED',
        shopifyOrderExternalId: oversizedNumericId,
      }),
    ).toThrow();
  });

  it('keeps synthetic collection views even when Shopify provides no durable collection identity', () => {
    expect(
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'COLLECTION_VIEW',
        pageUrl: 'https://store.example/collections/all',
      }),
    ).toMatchObject({ eventName: 'COLLECTION_VIEW' });

    expect(
      storefrontEventSchema.parse({
        ...baseEvent,
        eventName: 'COLLECTION_VIEW',
        collectionExternalId: '456',
      }),
    ).toMatchObject({
      eventName: 'COLLECTION_VIEW',
      collectionExternalId: 'gid://shopify/Collection/456',
    });
  });

  it('allows quantity only on cart mutation events', () => {
    expect(() => storefrontEventSchema.parse({ ...baseEvent, quantity: 1 })).toThrow();
  });
});
