import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { DashboardReadRepository } from '../../../src/modules/analytics/dashboard.read.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await prisma.orderLineItem.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('DashboardReadRepository top products', () => {
  it('ranks products by net Shopify line revenue inside the requested range', async () => {
    const suffix = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${suffix}`,
        name: 'Dashboard top products',
        myshopifyDomain: `dashboard-top-products-${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    stores.push(store.id);

    const productA = await prisma.product.create({
      data: { storeId: store.id, shopifyProductId: `gid://shopify/Product/${suffix}-a`, title: 'Core Hoodie', status: 'ACTIVE' },
    });
    const productB = await prisma.product.create({
      data: { storeId: store.id, shopifyProductId: `gid://shopify/Product/${suffix}-b`, title: 'Everyday Tee', status: 'ACTIVE' },
    });

    const orderA = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: `gid://shopify/Order/${suffix}-a`,
        name: '#A',
        shopifyCreatedAt: new Date('2026-09-05T10:00:00.000Z'),
        processedAt: new Date('2026-09-05T10:00:00.000Z'),
        currencyCode: 'USD',
        currentTotalAmount: '110',
        isTest: false,
      },
    });
    const orderB = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: `gid://shopify/Order/${suffix}-b`,
        name: '#B',
        shopifyCreatedAt: new Date('2026-09-06T10:00:00.000Z'),
        processedAt: new Date('2026-09-06T10:00:00.000Z'),
        currencyCode: 'USD',
        currentTotalAmount: '50',
        isTest: false,
      },
    });

    await prisma.orderLineItem.createMany({
      data: [
        { orderId: orderA.id, productId: productA.id, shopifyLineItemId: `${suffix}-a1`, title: productA.title, quantity: 2, currentQuantity: 2, discountedTotal: '80' },
        { orderId: orderA.id, productId: productB.id, shopifyLineItemId: `${suffix}-b1`, title: productB.title, quantity: 1, currentQuantity: 1, discountedTotal: '30' },
        { orderId: orderB.id, productId: productA.id, shopifyLineItemId: `${suffix}-a2`, title: productA.title, quantity: 1, currentQuantity: 1, discountedTotal: '50' },
      ],
    });

    const rows = await new DashboardReadRepository().getTopProducts({
      storeId: store.id,
      days: 30,
      from: '2026-09-05',
      to: '2026-09-06',
      now: new Date('2026-09-07T12:00:00.000Z'),
      limit: 2,
    });

    expect(rows).toEqual([
      { product: { id: productA.id, title: 'Core Hoodie' }, orderCount: 2, netUnits: 3, netRevenue: 130 },
      { product: { id: productB.id, title: 'Everyday Tee' }, orderCount: 1, netUnits: 1, netRevenue: 30 },
    ]);
  });
});
