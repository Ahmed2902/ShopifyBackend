import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyOrderRepository } from '../../../src/modules/shopify/shopify-order.repository.js';
import type { ShopifyOrder } from '../../../src/modules/shopify/shopify-order.schema.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

function money(amount: string) {
  return {
    shopMoney: { amount, currencyCode: 'USD' },
    presentmentMoney: { amount, currencyCode: 'USD' },
  };
}

function orderFixture(): ShopifyOrder {
  return {
    id: 'gid://shopify/Order/9001',
    name: '#9001',
    createdAt: '2026-08-01T10:00:00.000Z',
    processedAt: '2026-08-01T10:01:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    cancelledAt: null,
    cancelReason: null,
    sourceName: 'web',
    test: true,
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
      nodes: [
        {
          id: 'gid://shopify/LineItem/9001',
          sku: 'HOODIE-BLK-L',
          title: 'Black Hoodie',
          variantTitle: 'Large',
          quantity: 2,
          currentQuantity: 1,
          refundableQuantity: 1,
          requiresShipping: true,
          restockable: true,
          product: null,
          variant: null,
          originalUnitPriceSet: money('50.00'),
          originalTotalSet: money('100.00'),
          discountedTotalSet: money('90.00'),
          discountedUnitPriceAfterAllDiscountsSet: money('45.00'),
          totalDiscountSet: money('10.00'),
          discountAllocations: [{ allocatedAmountSet: money('10.00') }],
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: 'line-end' },
    },
    refunds: [
      {
        id: 'gid://shopify/Refund/9001',
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
              lineItem: { id: 'gid://shopify/LineItem/9001' },
              location: null,
              priceSet: money('50.00'),
              subtotalSet: money('45.00'),
              totalTaxSet: money('4.50'),
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: 'refund-line-end' },
        },
      },
    ],
  };
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
    const orderIds = orders.map((order) => order.id);
    if (orderIds.length > 0) {
      const refunds = await prisma.refund.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true },
      });
      const refundIds = refunds.map((refund) => refund.id);
      if (refundIds.length > 0) {
        await prisma.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
        await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
      }
      await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('ShopifyOrderRepository', () => {
  it('persists order/refund history idempotently with nullable refund IDs and source metadata', async () => {
    const unique = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${unique}`,
        name: 'Order Repository Test Store',
        myshopifyDomain: `order-repository-${unique}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
      select: { id: true },
    });
    createdStoreIds.push(store.id);

    const repository = new ShopifyOrderRepository();
    const order = orderFixture();

    const first = await repository.upsertOrderWithLineItems(store.id, order);
    expect(await repository.upsertRefundWithLineItems(store.id, first, order.refunds[0]!)).toBe(true);

    const second = await repository.upsertOrderWithLineItems(store.id, order);
    expect(await repository.upsertRefundWithLineItems(store.id, second, order.refunds[0]!)).toBe(true);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: {
        storeId_shopifyOrderId: {
          storeId: store.id,
          shopifyOrderId: order.id,
        },
      },
      include: {
        lineItems: true,
        refunds: { include: { lineItems: true } },
      },
    });

    expect(persisted.sourceName).toBe('web');
    expect(persisted.isTest).toBe(true);
    expect(persisted.lineItems).toHaveLength(1);
    expect(persisted.refunds).toHaveLength(1);
    expect(persisted.refunds[0]?.shopifyCreatedAt).toBeNull();
    expect(persisted.refunds[0]?.lineItems).toHaveLength(1);
    expect(persisted.refunds[0]?.lineItems[0]?.shopifyRefundLineId).toBeNull();
  });
});
