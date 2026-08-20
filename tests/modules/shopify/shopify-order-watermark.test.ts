import { describe, expect, it, vi } from 'vitest';
import type { ShopifyBulkService } from '../../../src/modules/shopify/bulk/shopify-bulk.service.js';
import type { ShopifyOrderRepository } from '../../../src/modules/shopify/order/shopify-order.repository.js';
import { ShopifyOrderService } from '../../../src/modules/shopify/order/shopify-order.service.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shop: 'example-store.myshopify.com',
  accessToken: 'access-token',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  apiVersion: '2026-07',
};

function money(amount: string) {
  return {
    shopMoney: { amount, currencyCode: 'USD' },
    presentmentMoney: { amount, currencyCode: 'USD' },
  };
}

const order = {
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-08-20T10:00:00.000Z',
  processedAt: '2026-08-20T10:01:00.000Z',
  updatedAt: '2026-08-20T10:10:00.000Z',
  cancelledAt: null,
  cancelReason: null,
  sourceName: 'web',
  test: false,
  currencyCode: 'USD',
  presentmentCurrencyCode: 'USD',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  currentSubtotalLineItemsQuantity: 1,
  currentSubtotalPriceSet: money('10.00'),
  currentShippingPriceSet: money('0.00'),
  currentTotalDiscountsSet: money('0.00'),
  currentTotalTaxSet: money('0.00'),
  currentTotalPriceSet: money('10.00'),
  discountCodes: [],
  refunds: [],
  lineItems: {
    nodes: [
      {
        id: 'gid://shopify/LineItem/1',
        sku: 'SKU-1',
        title: 'Product',
        variantTitle: 'Default',
        quantity: 1,
        currentQuantity: 1,
        refundableQuantity: 1,
        requiresShipping: true,
        restockable: true,
        product: { id: 'gid://shopify/Product/1' },
        variant: { id: 'gid://shopify/ProductVariant/1' },
        originalUnitPriceSet: money('10.00'),
        originalTotalSet: money('10.00'),
        discountedTotalSet: money('10.00'),
        discountedUnitPriceAfterAllDiscountsSet: money('10.00'),
        totalDiscountSet: money('0.00'),
        discountAllocations: [],
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

describe('ShopifyOrderService periodic reconciliation', () => {
  it('uses an overlap around the watermark and refetches only changed orders', async () => {
    const repository = {
      upsertOrderWithLineItems: vi.fn().mockResolvedValue({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        lineItems: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            shopifyLineItemId: 'gid://shopify/LineItem/1',
          },
        ],
      }),
    } as unknown as ShopifyOrderRepository;
    const requestAdminGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        orders: {
          nodes: [{ id: order.id, updatedAt: order.updatedAt }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })
      .mockResolvedValueOnce({ order });
    const service = new ShopifyOrderService(
      repository,
      { requestAdminGraphql } as unknown as ShopifyApiService,
      {} as ShopifyBulkService,
    );

    const result = await service.reconcileUpdatedOrders(
      context,
      new Date('2026-08-20T10:00:00.000Z'),
    );

    expect(result).toMatchObject({
      ordersScanned: 1,
      ordersReconciled: 1,
      breakdown: { orders: 1, lineItems: 1, refunds: 0, refundLineItems: 0 },
    });
    expect(requestAdminGraphql.mock.calls[0]?.[0].variables).toMatchObject({
      query: "updated_at:>'2026-08-20T09:55:00.000Z'",
    });
    expect(repository.upsertOrderWithLineItems).toHaveBeenCalledTimes(1);
  });
});
