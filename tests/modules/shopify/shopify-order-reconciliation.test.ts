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

function lineItem(id: string) {
  return {
    id,
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
  };
}

function orderPage(options?: {
  nodes?: ReturnType<typeof lineItem>[];
  hasNextPage?: boolean;
  cursor?: string | null;
  refunds?: unknown[];
}) {
  return {
    order: {
      id: 'gid://shopify/Order/1',
      name: '#1001',
      createdAt: '2026-08-01T10:00:00.000Z',
      processedAt: '2026-08-01T10:01:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      cancelledAt: null,
      cancelReason: null,
      sourceName: 'web',
      test: false,
      currencyCode: 'USD',
      presentmentCurrencyCode: 'USD',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      currentSubtotalLineItemsQuantity: 2,
      currentSubtotalPriceSet: money('20.00'),
      currentShippingPriceSet: money('0.00'),
      currentTotalDiscountsSet: money('0.00'),
      currentTotalTaxSet: money('0.00'),
      currentTotalPriceSet: money('20.00'),
      discountCodes: [],
      refunds: options?.refunds ?? [],
      lineItems: {
        nodes: options?.nodes ?? [lineItem('gid://shopify/LineItem/1')],
        pageInfo: {
          hasNextPage: options?.hasNextPage ?? false,
          endCursor: options?.cursor ?? null,
        },
      },
    },
  };
}

function refundResponse() {
  return {
    refund: {
      id: 'gid://shopify/Refund/1',
      createdAt: '2026-08-20T10:00:00.000Z',
      processedAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      totalRefundedSet: money('10.00'),
      refundLineItems: {
        nodes: [
          {
            id: 'gid://shopify/RefundLineItem/1',
            quantity: 1,
            restocked: true,
            restockType: 'RETURN',
            lineItem: { id: 'gid://shopify/LineItem/1' },
            location: null,
            priceSet: money('10.00'),
            subtotalSet: money('10.00'),
            totalTaxSet: money('0.00'),
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function buildService(responses: unknown[]) {
  const repository = {
    upsertOrderWithLineItems: vi.fn().mockResolvedValue({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      lineItems: [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          shopifyLineItemId: 'gid://shopify/LineItem/1',
        },
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          shopifyLineItemId: 'gid://shopify/LineItem/2',
        },
      ],
    }),
    upsertRefundWithLineItems: vi.fn().mockResolvedValue(true),
  } as unknown as ShopifyOrderRepository;
  const requestAdminGraphql = vi.fn();
  for (const response of responses) requestAdminGraphql.mockResolvedValueOnce(response);

  return {
    repository,
    requestAdminGraphql,
    service: new ShopifyOrderService(
      repository,
      { requestAdminGraphql } as unknown as ShopifyApiService,
      {} as ShopifyBulkService,
    ),
  };
}

describe('ShopifyOrderService current-order reconciliation', () => {
  it('paginates only the line items of the single changed order and persists one complete order', async () => {
    const first = orderPage({
      nodes: [lineItem('gid://shopify/LineItem/1')],
      hasNextPage: true,
      cursor: 'line-cursor-1',
    });
    const second = orderPage({
      nodes: [lineItem('gid://shopify/LineItem/2')],
      hasNextPage: false,
    });
    const { repository, requestAdminGraphql, service } = buildService([first, second]);

    const result = await service.reconcileOrder(context, 'gid://shopify/Order/1');

    expect(result).toMatchObject({ found: true });
    expect(requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(requestAdminGraphql.mock.calls[1]?.[0].variables).toMatchObject({
      after: 'line-cursor-1',
    });
    expect(repository.upsertOrderWithLineItems).toHaveBeenCalledWith(
      context.storeId,
      expect.objectContaining({
        id: 'gid://shopify/Order/1',
        lineItems: [
          expect.objectContaining({ id: 'gid://shopify/LineItem/1' }),
          expect.objectContaining({ id: 'gid://shopify/LineItem/2' }),
        ],
      }),
    );
  });

  it('hydrates and persists refunds while reconciling the changed order', async () => {
    const refundHeader = {
      id: 'gid://shopify/Refund/1',
      createdAt: '2026-08-20T10:00:00.000Z',
      processedAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      totalRefundedSet: money('10.00'),
    };
    const { repository, service } = buildService([
      orderPage({ refunds: [refundHeader] }),
      refundResponse(),
    ]);

    const result = await service.reconcileOrder(context, 'gid://shopify/Order/1');

    expect(result).toMatchObject({
      found: true,
      result: {
        breakdown: { orders: 1, lineItems: 1, refunds: 1, refundLineItems: 1 },
      },
    });
    expect(repository.upsertRefundWithLineItems).toHaveBeenCalledTimes(1);
  });

  it('returns not found without writing when the order was deleted before processing', async () => {
    const { repository, service } = buildService([{ order: null }]);

    await expect(service.reconcileOrder(context, 'gid://shopify/Order/1')).resolves.toEqual({
      found: false,
    });
    expect(repository.upsertOrderWithLineItems).not.toHaveBeenCalled();
  });
});
