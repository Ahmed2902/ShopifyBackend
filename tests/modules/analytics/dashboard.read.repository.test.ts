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
  return { store, suffix };
}

async function cleanup(storeId: string) {
  await prisma.refundLineItem.deleteMany({ where: { orderLineItem: { order: { storeId } } } });
  await prisma.orderLineItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('DashboardReadRepository', () => {
  it('selects recent orders first and reports quantities for only the requested rows', async () => {
    const { store } = await createStore();
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

  it('ranks top products globally by net Shopify product revenue instead of catalog page order', async () => {
    const { store, suffix } = await createStore();
    const productA = await prisma.product.create({
      data: {
        storeId: store.id,
        shopifyProductId: `gid://shopify/Product/${suffix}-a`,
        title: 'Core Hoodie',
        status: 'ACTIVE',
      },
    });
    const productB = await prisma.product.create({
      data: {
        storeId: store.id,
        shopifyProductId: `gid://shopify/Product/${suffix}-b`,
        title: 'Everyday Tee',
        status: 'ACTIVE',
      },
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
        {
          orderId: orderA.id,
          productId: productA.id,
          shopifyLineItemId: `${suffix}-a1`,
          title: productA.title,
          quantity: 2,
          currentQuantity: 2,
          discountedTotal: '80',
        },
        {
          orderId: orderA.id,
          productId: productB.id,
          shopifyLineItemId: `${suffix}-b1`,
          title: productB.title,
          quantity: 1,
          currentQuantity: 1,
          discountedTotal: '30',
        },
        {
          orderId: orderB.id,
          productId: productA.id,
          shopifyLineItemId: `${suffix}-a2`,
          title: productA.title,
          quantity: 1,
          currentQuantity: 1,
          discountedTotal: '50',
        },
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

  it('counts first-touch paid sessions once and splits Meta into Facebook or Instagram only with evidence', async () => {
    const { store, suffix } = await createStore();
    const retentionExpiresAt = new Date('2027-01-01T00:00:00.000Z');

    async function createSession(
      key: string,
      startedAt: string,
      source: 'META' | 'GOOGLE' | 'TIKTOK' | 'UTM',
      evidence: { utmSource?: string; utmMedium?: string; referrerUrl?: string } = {},
    ) {
      const at = new Date(startedAt);
      await prisma.storefrontSession.create({
        data: {
          storeId: store.id,
          browserSessionId: `${suffix}-${key}`,
          startedAt: at,
          endedAt: new Date(at.getTime() + 60_000),
          lastSourceReceivedAt: at,
          eventCount: 1,
          retentionExpiresAt,
          touches: {
            create: {
              ordinal: 1,
              eventAt: at,
              source,
              utmSource: evidence.utmSource,
              utmMedium: evidence.utmMedium,
              referrerUrl: evidence.referrerUrl,
            },
          },
        },
      });
    }

    await createSession('facebook', '2026-09-06T10:00:00.000Z', 'META', { utmSource: 'facebook' });
    await createSession('instagram-referrer', '2026-09-06T11:00:00.000Z', 'META', { referrerUrl: 'https://l.instagram.com/' });
    await createSession('meta-unknown-surface', '2026-09-06T12:00:00.000Z', 'META');
    await createSession('google', '2026-09-06T13:00:00.000Z', 'GOOGLE');
    await createSession('instagram-paid-utm', '2026-09-06T14:00:00.000Z', 'UTM', { utmSource: 'instagram', utmMedium: 'paid_social' });
    await createSession('instagram-organic-utm', '2026-09-06T15:00:00.000Z', 'UTM', { utmSource: 'instagram', utmMedium: 'social' });
    await createSession('tiktok-comparison', '2026-09-04T10:00:00.000Z', 'TIKTOK');

    const result = await new DashboardReadRepository().getAdPlatformSessions({
      storeId: store.id,
      days: 2,
      now: new Date('2026-09-07T12:00:00.000Z'),
    });

    expect(result.methodology).toBe('FIRST_TOUCH_PAID_PLATFORM');
    expect(result.items).toEqual([
      { platform: 'INSTAGRAM', currentSessions: 2, comparisonSessions: 0, change: null },
      { platform: 'FACEBOOK', currentSessions: 1, comparisonSessions: 0, change: null },
      { platform: 'GOOGLE', currentSessions: 1, comparisonSessions: 0, change: null },
      { platform: 'META', currentSessions: 1, comparisonSessions: 0, change: null },
      { platform: 'TIKTOK', currentSessions: 0, comparisonSessions: 1, change: -1 },
    ]);
  });
});
