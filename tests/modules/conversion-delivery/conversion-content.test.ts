import { describe, expect, it, vi } from 'vitest';
import {
  metaCustomData,
  prepareConversionContents,
  resolveContentItems,
  tiktokProperties,
} from '../../../src/modules/conversion-delivery/conversion-content.js';
import type { DeliveryClaim } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';
const mocks = vi.hoisted(() => ({
  orders: vi.fn(),
  events: vi.fn(),
  meta: vi.fn(),
  tiktok: vi.fn(),
}));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    order: { findMany: mocks.orders },
    storefrontEvent: { findMany: mocks.events },
    catalogItemVariantMapping: { findMany: mocks.meta },
    tikTokCatalogItemVariantMapping: { findMany: mocks.tiktok },
  },
}));
const variant = 'gid://shopify/ProductVariant/10';
function mapping(id: string, storeId = 'store-a', catalog = 'catalog-a') {
  return {
    variant: { shopifyVariantId: variant, storeId },
    catalogItem: { retailerId: id, catalog: { id: catalog, storeId } },
  };
}
describe('catalog aligned conversion content', () => {
  it('omits unknown and conflicting item IDs instead of guessing a Shopify ID scheme', () => {
    const result = resolveContentItems(
      [{ variantExternalId: variant, quantity: 2 }],
      [mapping('SKU-A'), mapping('SKU-B')],
    );
    expect(result.contents).toEqual([]);
    expect(result.contentFacts).toMatchObject({
      observedItems: 1,
      mappedItems: 0,
      ambiguousItems: 1,
    });
    expect(resolveContentItems([{ variantExternalId: variant }], []).contents).toEqual([]);
  });
  it('deduplicates identical mappings and preserves zero prices and Unicode retailer IDs', () => {
    const result = resolveContentItems(
      [{ variantExternalId: variant, quantity: 2, itemPrice: 0 }],
      [mapping('عربي-10'), mapping('عربي-10')],
    );
    expect(result.contents).toEqual([{ id: 'عربي-10', quantity: 2, itemPrice: 0 }]);
    const claim = {
      ...result,
      currencyCode: 'USD',
      value: 0,
      shopifyOrderId: 'gid://shopify/Order/1',
    } as unknown as DeliveryClaim;
    expect(metaCustomData(claim)).toMatchObject({
      contents: [{ id: 'عربي-10', quantity: 2, item_price: 0 }],
      num_items: 2,
      value: 0,
    });
    expect(tiktokProperties(claim)).toMatchObject({
      contents: [{ content_id: 'عربي-10', quantity: 2, price: 0 }],
      quantity: 2,
    });
    expect(tiktokProperties(claim)).not.toHaveProperty('num_items');
  });
  it('does not claim partial catalog quantities as complete basket quantities', () => {
    const result = resolveContentItems(
      [
        { variantExternalId: variant, quantity: 2 },
        { variantExternalId: 'gid://shopify/ProductVariant/99', quantity: 3 },
      ],
      [mapping('SKU-A')],
    );
    expect(metaCustomData(result as unknown as DeliveryClaim)).not.toHaveProperty('num_items');
    expect(
      resolveContentItems(
        Array.from({ length: 101 }, () => ({ variantExternalId: variant })),
        [mapping('SKU-A')],
      ).contentFacts.truncated,
    ).toBe(true);
  });
  it('omits unit prices without currency, missing money and empty content fields', () => {
    const payload = metaCustomData({
      value: null,
      currencyCode: null,
      contents: [{ id: 'sku', itemPrice: 20 }],
    } as DeliveryClaim);
    expect(payload).toEqual({
      content_type: 'product',
      content_ids: ['sku'],
      contents: [{ id: 'sku' }],
    });
    expect(metaCustomData({ value: null } as DeliveryClaim)).toEqual({});
  });
  it('batches tenant scoped reads and uses original order quantities and canonical unit prices for Purchase', async () => {
    mocks.orders.mockResolvedValue([
      {
        id: 'order-a',
        storeId: 'store-a',
        lineItems: [
          {
            shopifyVariantId: variant,
            quantity: 2,
            discountedUnitPriceAfterAllDiscounts: '9.5',
            originalUnitPrice: '12',
          },
        ],
      },
    ]);
    mocks.events.mockResolvedValue([
      {
        id: 'event-a',
        storeId: 'store-a',
        commerceItems: [{ variantExternalId: variant, quantity: 999, itemPrice: 0 }],
        commerceCurrencyCode: 'EUR',
      },
    ]);
    mocks.meta.mockResolvedValue([
      mapping('SKU-A'),
      mapping('FOREIGN', 'store-b'),
      mapping('WRONG-CATALOG', 'store-a', 'catalog-b'),
    ]);
    const claims = [1, 2].map(
      (i) =>
        ({
          id: String(i),
          storeId: 'store-a',
          provider: 'META',
          eventName: 'PURCHASE',
          sourceOrderId: 'order-a',
          sourceEventId: 'event-a',
          value: '25',
          currencyCode: 'USD',
          destination: { configJson: { catalogId: 'catalog-a' } },
        }) as unknown as DeliveryClaim,
    );
    await prepareConversionContents(claims);
    for (const c of claims) {
      expect(c.contents).toEqual([{ id: 'SKU-A', quantity: 2, itemPrice: 9.5 }]);
      expect(c.value).toBe('25');
      expect(c.currencyCode).toBe('USD');
    }
    expect(mocks.orders).toHaveBeenCalledOnce();
    expect(mocks.events).toHaveBeenCalledOnce();
    expect(mocks.meta).toHaveBeenCalledOnce();
    expect(mocks.meta.mock.calls[0]![0].where.catalogItem.catalog.storeId.in).toEqual(['store-a']);
  });
  it('keeps browser observed funnel prices separate from commerce truth and omits unknown totals', async () => {
    mocks.events.mockResolvedValue([
      {
        id: 'event-b',
        storeId: 'store-a',
        commerceItems: [{ variantExternalId: variant, quantity: 3, itemPrice: 2.5 }],
        commerceCurrencyCode: 'USD',
      },
    ]);
    const c = {
      id: 'c',
      provider: 'META',
      storeId: 'store-a',
      eventName: 'ADD_TO_CART',
      sourceOrderId: null,
      sourceEventId: 'event-b',
      value: null,
      currencyCode: null,
      destination: { configJson: {} },
    } as unknown as DeliveryClaim;
    await prepareConversionContents([c]);
    expect(Number(c.value)).toBe(7.5);
    expect(c.currencyCode).toBe('USD');
    expect(c.contents).toEqual([]);
    expect(c.contentFacts).toMatchObject({ observedItems: 1, mappedItems: 0 });
  });
});
