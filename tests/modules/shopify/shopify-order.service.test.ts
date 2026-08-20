import { describe, expect, it, vi } from 'vitest';
import type { ShopifyOrderRepository } from '../../../src/modules/shopify/shopify-order.repository.js';
import { ShopifyOrderService } from '../../../src/modules/shopify/service/shopify-order.service.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/service/shopify-api.service.js';
import type { ShopifyBulkService } from '../../../src/modules/shopify/service/shopify-bulk.service.js';

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

function orderLine() {
  return {
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
    refunds: [
      {
        id: 'gid://shopify/Refund/1',
        createdAt: null,
        processedAt: '2026-08-02T10:01:00.000Z',
        updatedAt: '2026-08-02T10:02:00.000Z',
        totalRefundedSet: money('49.50'),
      },
    ],
  };
}

function lineItemLine(id = 'gid://shopify/LineItem/1') {
  return {
    id,
    __parentId: 'gid://shopify/Order/1',
    sku: 'HOODIE-BLK-L',
    title: 'Black Hoodie',
    variantTitle: 'Large',
    quantity: 2,
    currentQuantity: 1,
    refundableQuantity: 1,
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

function refundResponse(options?: { hasNextPage?: boolean; id?: string }) {
  return {
    refund: {
      id: options?.id ?? 'gid://shopify/Refund/1',
      createdAt: null,
      processedAt: '2026-08-02T10:01:00.000Z',
      updatedAt: '2026-08-02T10:02:00.000Z',
      totalRefundedSet: money('49.50'),
      refundLineItems: {
        nodes: [
          {
            id: null,
            quantity: 1,
            restocked: true,
            restockType: 'RETURN',
            lineItem: { id: 'gid://shopify/LineItem/1' },
            location: null,
            priceSet: money('50.00'),
            subtotalSet: money('45.00'),
            totalTaxSet: money('4.50'),
          },
        ],
        pageInfo: {
          hasNextPage: options?.hasNextPage ?? false,
          endCursor: options?.hasNextPage ? 'refund-cursor-1' : null,
        },
      },
    },
  };
}

function buildService(options?: {
  status?: Record<string, unknown>;
  lines?: unknown[];
  refundResponses?: unknown[];
}) {
  const persistedOrder = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    lineItems: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        shopifyLineItemId: 'gid://shopify/LineItem/1',
      },
    ],
  };
  const repository = {
    upsertOrderWithLineItems: vi.fn().mockResolvedValue(persistedOrder),
    upsertRefundWithLineItems: vi.fn().mockResolvedValue(true),
  } as unknown as ShopifyOrderRepository;

  const requestAdminGraphql = vi.fn();
  for (const response of options?.refundResponses ?? [refundResponse()]) {
    requestAdminGraphql.mockResolvedValueOnce(response);
  }
  const apiService = { requestAdminGraphql } as unknown as ShopifyApiService;

  const lines = options?.lines ?? [orderLine(), lineItemLine()];
  const bulkService = {
    startQuery: vi.fn().mockResolvedValue({
      id: 'gid://shopify/BulkOperation/1',
      status: 'CREATED',
    }),
    getStatus: vi.fn().mockResolvedValue(
      options?.status ?? {
        id: 'gid://shopify/BulkOperation/1',
        status: 'COMPLETED',
        errorCode: null,
        objectCount: '2',
        url: 'https://storage.example/orders.jsonl',
        partialDataUrl: null,
      },
    ),
    streamJsonl: async function* () {
      for (const line of lines) yield line;
    },
  } as unknown as ShopifyBulkService;

  return {
    repository,
    apiService,
    bulkService,
    service: new ShopifyOrderService(repository, apiService, bulkService),
  };
}

describe('ShopifyOrderService bulk history', () => {
  it('starts one Shopify bulk operation for order history', async () => {
    const { bulkService, service } = buildService();

    const result = await service.startBulkBackfill(syncContext);

    expect(result).toMatchObject({ id: 'gid://shopify/BulkOperation/1', status: 'CREATED' });
    expect(bulkService.startQuery).toHaveBeenCalledTimes(1);
  });

  it('returns running state without downloading the bulk file', async () => {
    const { repository, service } = buildService({
      status: {
        id: 'gid://shopify/BulkOperation/1',
        status: 'RUNNING',
        objectCount: '120',
        url: null,
      },
    });

    const result = await service.inspectBulkBackfill(
      syncContext,
      'gid://shopify/BulkOperation/1',
    );

    expect(result).toEqual({ state: 'RUNNING', providerStatus: 'RUNNING', objectCount: '120' });
    expect(repository.upsertOrderWithLineItems).not.toHaveBeenCalled();
  });

  it('streams order history, reconstructs line items, and hydrates refunds only where Shopify bulk cannot', async () => {
    const { repository, apiService, service } = buildService();

    const result = await service.inspectBulkBackfill(
      syncContext,
      'gid://shopify/BulkOperation/1',
    );

    expect(result).toEqual({
      state: 'COMPLETED',
      providerStatus: 'COMPLETED',
      recordsRead: 4,
      recordsWritten: 4,
      breakdown: { orders: 1, lineItems: 1, refunds: 1, refundLineItems: 1 },
    });
    expect(repository.upsertOrderWithLineItems).toHaveBeenCalledWith(
      syncContext.storeId,
      expect.objectContaining({
        id: 'gid://shopify/Order/1',
        sourceName: 'web',
        test: false,
        lineItems: [expect.objectContaining({ id: 'gid://shopify/LineItem/1' })],
      }),
    );
    expect(repository.upsertRefundWithLineItems).toHaveBeenCalledTimes(1);
    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(1);
  });

  it('paginates only the rare refund-line overflow that Shopify bulk cannot represent', async () => {
    const secondRefundPage = refundResponse();
    const { repository, apiService, service } = buildService({
      refundResponses: [refundResponse({ hasNextPage: true }), secondRefundPage],
    });

    const result = await service.inspectBulkBackfill(
      syncContext,
      'gid://shopify/BulkOperation/1',
    );

    expect(result.state).toBe('COMPLETED');
    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(2);
    const refund = vi.mocked(repository.upsertRefundWithLineItems).mock.calls[0]?.[2];
    expect(refund?.refundLineItems.nodes).toHaveLength(2);
  });

  it('rejects a malformed JSONL parent relationship', async () => {
    const badLine = { ...lineItemLine(), __parentId: 'gid://shopify/Order/999' };
    const { service } = buildService({ lines: [orderLine(), badLine] });

    await expect(
      service.inspectBulkBackfill(syncContext, 'gid://shopify/BulkOperation/1'),
    ).rejects.toMatchObject({ code: 'SHOPIFY_ORDER_INCONSISTENT' });
  });

  it('surfaces terminal Shopify bulk failures without importing partial data', async () => {
    const { repository, service } = buildService({
      status: {
        id: 'gid://shopify/BulkOperation/1',
        status: 'FAILED',
        errorCode: 'TIMEOUT',
        partialDataUrl: 'https://storage.example/partial.jsonl',
      },
    });

    const result = await service.inspectBulkBackfill(
      syncContext,
      'gid://shopify/BulkOperation/1',
    );

    expect(result).toEqual({ state: 'FAILED', providerStatus: 'FAILED', errorCode: 'TIMEOUT' });
    expect(repository.upsertOrderWithLineItems).not.toHaveBeenCalled();
  });
});
