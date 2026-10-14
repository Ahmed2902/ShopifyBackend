import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { acquireDispatch } from '../../../src/modules/conversion-delivery/dispatch-control.js';
import { ShopifyOrderRepository } from '../../../src/modules/shopify/order/shopify-order.repository.js';

const database = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
const money = (amount: string) => ({ shopMoney: { amount, currencyCode: 'USD' }, presentmentMoney: { amount, currencyCode: 'USD' } });
async function store() {
  const id = randomUUID();
  const s = await prisma.store.create({ data: { shopifyShopId: id, name: 'Dispatch test', myshopifyDomain: id + '.myshopify.com', currencyCode: 'USD', ianaTimezone: 'UTC' } });
  stores.push(s.id); return s;
}
afterEach(async () => {
  for (const id of stores.splice(0)) {
    const orders = await prisma.order.findMany({ where: { storeId: id }, select: { id: true } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orders.map(o => o.id) } } });
    await prisma.order.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } });
  }
});
database('durable dispatch and purchase snapshots', () => {
  it('serializes concurrent merchant/provider dispatch reservations', async () => {
    const s = await store();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => acquireDispatch(s.id, 'META')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(19);
    await expect(acquireDispatch(s.id, 'TIKTOK')).resolves.toBeUndefined();
  });
  it('keeps purchase facts stable after an edit, cancellation and repeated reconciliation', async () => {
    const s = await store();
    const now = new Date().toISOString();
    const header = { id: 'gid://shopify/Order/7711', name: '#7711', createdAt: now, processedAt: now, sourceName: 'web',
      test: false, currencyCode: 'USD', originalTotalPriceSet: money('100'), currentTotalPriceSet: money('100'),
      currentSubtotalPriceSet: money('100'), currentShippingPriceSet: money('0'), currentTotalTaxSet: money('0'),
      currentTotalDiscountsSet: money('0'), discountCodes: [], refunds: [],
      lineItems: [{ id: 'gid://shopify/LineItem/7711', title: 'Item', quantity: 2, currentQuantity: 2,
        variant: { id: 'gid://shopify/ProductVariant/7711' }, requiresShipping: true, restockable: true,
        originalUnitPriceSet: money('50'), originalTotalSet: money('100'), discountedTotalSet: money('100'),
        discountedUnitPriceAfterAllDiscountsSet: money('50'), totalDiscountSet: money('0'), discountAllocations: [] }] };
    const repo = new ShopifyOrderRepository();
    const first = await repo.upsertOrderWithLineItems(s.id, header);
    const before = await prisma.order.findUniqueOrThrow({ where: { id: first!.id } });
    await repo.upsertOrderWithLineItems(s.id, { ...header, currentTotalPriceSet: money('20'), cancelledAt: now,
      lineItems: header.lineItems.map(l => ({ ...l, quantity: 1, currentQuantity: 0 })) });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: first!.id } });
    expect(after.purchaseFacts).toEqual(before.purchaseFacts);
    expect(after.currentTotalAmount?.toString()).toBe('20');
  });
});
