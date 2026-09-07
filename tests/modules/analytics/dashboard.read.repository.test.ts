import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { DashboardReadRepository } from '../../../src/modules/analytics/dashboard.read.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Dashboard read performance fixture',
      myshopifyDomain: `dashboard-read-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  return store;
}

async function cleanup(storeId: string) {
  await prisma.orderLineItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('DashboardReadRepository', () => {
  it('selects recent orders first and reports quantities for only the requested rows', async () => {
    const store = await createStore();
    const base = new Date('2026-09-01T12:00:00.000Z');

    for (let index = 0; index < 7; index += 1) {
      const order = await prisma.order.create({
        data: {
          storeId: store.id,
          shopifyOrderId: `gid://shopify/Order/${index + 1}`,
          name: `#10${index + 1}`,
          shopifyCreatedAt: new Date(base.getTime() + index * 60_000),
          processedAt: new Date(base.getTime() + index * 60_000),
          currencyCode: 'USD',
          currentTotalAmount: (index + 1) * 10,
          isTest: false,
        },
      });

      await prisma.orderLineItem.createMany({
        data: [
          {
            orderId: order.id,
            shopifyLineItemId: `line-a-${index}`,
            title: 'A',
            quantity: 1,
            currentQuantity: index + 1,
            requiresShipping: true,
            restockable: false,
          },
          {
            orderId: order.id,
            shopifyLineItemId: `line-b-${index}`,
            title: 'B',
            quantity: 1,
            currentQuantity: 2,
            requiresShipping: true,
            restockable: false,
          },
        ],
      });
    }

    // A newer test order must not consume one of the six merchant-visible slots.
    await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: 'gid://shopify/Order/test',
        name: '#TEST',
        shopifyCreatedAt: new Date('2026-09-02T00:00:00.000Z'),
        processedAt: new Date('2026-09-02T00:00:00.000Z'),
        currencyCode: 'USD',
        currentTotalAmount: 999,
        isTest: true,
      },
    });

    const rows = await new DashboardReadRepository().getRecentOrders(store.id, 6);

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.name)).toEqual(['#107', '#106', '#105', '#104', '#103', '#102']);
    expect(rows[0]).toMatchObject({
      name: '#107',
      currencyCode: 'USD',
      currentTotalAmount: 70,
      currentQuantity: 9,
    });
    expect(rows.at(-1)).toMatchObject({
      name: '#102',
      currentQuantity: 4,
    });
  });
});
