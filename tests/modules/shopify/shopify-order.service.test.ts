import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyOrderRepository } from '../../../src/modules/shopify/shopify-order.repository.js';
import { ShopifyOrderService } from '../../../src/modules/shopify/service/shopify-order.service.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/service/shopify-api.service.js';

const syncContext = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shop: 'example-store.myshopify.com',
  accessToken: 'shopify-access-token',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  apiVersion: '2026-07',
  syncRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
    sku: `SKU-${id}`,
    title: 'Black Hoodie',
    variantTitle: 'Large',
    quantity: 2,
    currentQuantity: 2,
    refundableQuantity: 2,
    requiresShipping: true,
    restockable: true,
    product: { id: 'gid://shopify/Product/1' },
    variant: { id: 'gid://shopify/ProductVariant/1' },
    originalUnitPriceSet: money('50.00'),
    originalTotalSet: money('100.00'),
    discountedTotalSet: money('90.00'),
    discountedUnitPriceAfterAllDiscountsSet: money('45.00'),
    totalDiscountSet: money('10.00'),
    discountAllocations: [{ allocatedAmountSet: money('10.00') }],
  };
}

function refundLineItem(id: string, orderLineItemId: string) {
  return {
    id,
    quantity: 1,
    restocked: true,
    restockType: 'RETURN',
    lineItem: { id: orderLineItemId },
    location: { id: 'gid://shopify/Location/1' },
    priceSet: money('50.00'),
    subtotalSet: money('45.00'),
    totalTaxSet: money('4.50'),
  };
}

function orderResponse(options?: {
  lineItemsHasNextPage?: boolean;
  refundLinesHasNextPage?: boolean;
  orderHasNextPage?: boolean;
  orderCursor?: string | null;
}) {
  return {
    orders: {
      nodes: [
        {
          id: 'gid://shopify/Order/1',
          name: '#1001',
          createdAt: '2026-08-01T10:00:00.000Z',
          processedAt: '2026-08-01T10:01:00.000Z',
          updatedAt: '2026-08-02T10:00:00.000Z',
          cancelledAt: null,
          cancelReason: null,
          sourceName: 'web',
          test: false,
          currencyCode: 'USD',
          presentmentCurrencyCode: 'USD',
          displayFinancialStatus: 'PARTIALLY_REFUNDED',
          displayFulfillmentStatus: 'FULFILLED',
          currentSubtotalLineItemsQuantity: 1,
          currentSubtotalPriceSet: money('45.00'),
          currentShippingPriceSet: money('5.00'),
          currentTotalDiscountsSet: money('10.00'),
          currentTotalTaxSet: money('4.50'),
          currentTotalPriceSet: money('54.50'),
          discountCodes: ['WELCOME10'],
          lineItems: {
            nodes: [lineItem('gid://shopify/LineItem/1')],
            pageInfo: {
              hasNextPage: options?.lineItemsHasNextPage ?? false,
              endCursor: options?.lineItemsHasNextPage ? 'line-cursor-1' : null,
            },
          },
          refunds: [
            {
              id: 'gid://shopify/Refund/1',
              createdAt: '2026-08-02T10:00:00.000Z',
              processedAt: '2026-08-02T10:01:00.000Z',
              updatedAt: '2026-08-02T10:02:00.000Z',
              totalRefundedSet: money('49.50'),
              refundLineItems: {
                nodes: [
                  refundLineItem(
                    'gid://shopify/RefundLineItem/1',
                    'gid://shopify/LineItem/1',
                  ),
                ],
                pageInfo: {
                  hasNextPage: options?.refundLinesHasNextPage ?? false,
                  endCursor: options?.refundLinesHasNextPage ? 'refund-line-cursor-1' : null,
                },
              },
            },
          ],
        },
      ],
      pageInfo: {
        hasNextPage: options?.orderHasNextPage ?? false,
        endCursor:
          options?.orderCursor === undefined ? 'order-cursor-1' : options.orderCursor,
      },
    },
  };
}

function buildService(apiResponses: unknown[]) {
  const persistedOrder = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    lineItems: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        shopifyLineItemId: 'gid://shopify/LineItem/1',
      },
      {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        shopifyLineItemId: 'gid://shopify/LineItem/2',
      },
    ],
  };

  const repository = {
    upsertOrderWithLineItems: vi.fn().mockResolvedValue(persistedOrder),
    upsertRefundWithLineItems: vi.fn().mockResolvedValue(true),
  } as unknown as ShopifyOrderRepository;

  const integrationService = {
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
    updateSyncRunProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;

  const requestAdminGraphql = vi.fn();
  for (const response of apiResponses) {
    requestAdminGraphql.mockResolvedValueOnce(response);
  }

  const apiService = {
    requestAdminGraphql,
  } as unknown as ShopifyApiService;

  return {
    repository,
    integrationService,
    apiService,
    service: new ShopifyOrderService(repository, integrationService, apiService),
  };
}

describe('ShopifyOrderService', () => {
  it('persists orders, line items, refunds and refund lines with progress checkpoints', async () => {
    const { repository, integrationService, service } = buildService([orderResponse()]);

    const result = await service.sync(syncContext);

    expect(result).toEqual({
      recordsRead: 4,
      recordsWritten: 4,
      checkpointCursor: 'order-cursor-1',
      breakdown: {
        orders: 1,
        lineItems: 1,
        refunds: 1,
        refundLineItems: 1,
      },
    });
    expect(repository.upsertOrderWithLineItems).toHaveBeenCalledTimes(1);
    expect(repository.upsertRefundWithLineItems).toHaveBeenCalledTimes(1);
    expect(integrationService.updateSyncRunProgress).toHaveBeenCalledWith(syncContext.syncRunId, {
      cursor: 'order-cursor-1',
      recordsRead: 4,
      recordsWritten: 4,
    });
  });

  it('hydrates nested line-item pagination instead of silently truncating large orders', async () => {
    const extraOrderLines = {
      order: {
        lineItems: {
          nodes: [lineItem('gid://shopify/LineItem/2')],
          pageInfo: { hasNextPage: false, endCursor: 'line-cursor-2' },
        },
      },
    };
    const extraRefundLines = {
      refund: {
        refundLineItems: {
          nodes: [
            refundLineItem(
              'gid://shopify/RefundLineItem/2',
              'gid://shopify/LineItem/2',
            ),
          ],
          pageInfo: { hasNextPage: false, endCursor: 'refund-line-cursor-2' },
        },
      },
    };
    const { repository, apiService, service } = buildService([
      orderResponse({ lineItemsHasNextPage: true, refundLinesHasNextPage: true }),
      extraOrderLines,
      extraRefundLines,
    ]);

    const result = await service.sync(syncContext);

    expect(result.recordsRead).toBe(6);
    expect(result.breakdown.lineItems).toBe(2);
    expect(result.breakdown.refundLineItems).toBe(2);
    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(3);

    const savedOrder = vi.mocked(repository.upsertOrderWithLineItems).mock.calls[0]?.[1];
    expect(savedOrder?.lineItems.nodes).toHaveLength(2);
    expect(savedOrder?.sourceName).toBe('web');
    expect(savedOrder?.test).toBe(false);

    const savedRefund = vi.mocked(repository.upsertRefundWithLineItems).mock.calls[0]?.[2];
    expect(savedRefund?.refundLineItems.nodes).toHaveLength(2);
  });

  it('fails rather than dropping a refund whose line item was not persisted', async () => {
    const { repository, service } = buildService([orderResponse()]);
    vi.mocked(repository.upsertRefundWithLineItems).mockResolvedValue(false);

    await expect(service.sync(syncContext)).rejects.toMatchObject({
      code: 'SHOPIFY_ORDER_INCONSISTENT',
    });
  });

  it('fails if Shopify repeats a top-level order cursor', async () => {
    const { service } = buildService([
      orderResponse({ orderHasNextPage: true, orderCursor: 'repeat-cursor' }),
      orderResponse({ orderHasNextPage: true, orderCursor: 'repeat-cursor' }),
    ]);

    await expect(service.sync(syncContext)).rejects.toMatchObject({
      code: 'SHOPIFY_BAD_RESPONSE',
    });
  });

  it('fails if Shopify says another order page exists without a cursor', async () => {
    const { service } = buildService([
      orderResponse({ orderHasNextPage: true, orderCursor: null }),
    ]);

    await expect(service.sync(syncContext)).rejects.toMatchObject({
      code: 'SHOPIFY_BAD_RESPONSE',
    });
  });
});
