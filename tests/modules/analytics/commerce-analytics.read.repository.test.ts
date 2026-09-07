import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { resolveAnalyticsWindows } from '../../../src/modules/analytics/analytics.dates.js';
import { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import { CommerceAnalyticsReadRepository } from '../../../src/modules/analytics/commerce-analytics.read.repository.js';
import { CommerceAnalyticsService } from '../../../src/modules/analytics/commerce-analytics.service.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createOrder(input: {
  storeId: string;
  suffix: string;
  processedAt: string;
  shopifyCreatedAt?: string;
  currencyCode?: string;
  amount: string;
  discounts?: string;
  units?: number;
  customerJourneyReady?: boolean;
  customerOrderIndex?: number | null;
  isTest?: boolean;
  cancelledAt?: string;
}) {
  return prisma.order.create({
    data: {
      storeId: input.storeId,
      shopifyOrderId: `gid://shopify/Order/${input.suffix}-${randomUUID()}`,
      name: `#${input.suffix}`,
      shopifyCreatedAt: new Date(input.shopifyCreatedAt ?? input.processedAt),
      processedAt: new Date(input.processedAt),
      isTest: input.isTest ?? false,
      cancelledAt: input.cancelledAt ? new Date(input.cancelledAt) : null,
      currencyCode: input.currencyCode ?? 'USD',
      currentSubtotalLineItemsQuantity: input.units ?? 1,
      currentTotalAmount: input.amount,
      currentTotalDiscountsAmount: input.discounts ?? '0',
      customerJourneyReady: input.customerJourneyReady ?? true,
      customerOrderIndex: input.customerOrderIndex ?? 1,
    },
  });
}

async function fixture() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Commerce aggregate parity',
      myshopifyDomain: `commerce-parity-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);

  const currentNew = await createOrder({
    storeId: store.id,
    suffix: 'CURRENT-NEW',
    // shopifyCreatedAt intentionally falls outside the window; processedAt owns demand cohorting.
    shopifyCreatedAt: '2026-01-01T10:00:00.000Z',
    processedAt: '2026-08-10T10:00:00.000Z',
    amount: '100',
    discounts: '10',
    units: 2,
    customerOrderIndex: 1,
  });
  await prisma.refund.create({
    data: {
      orderId: currentNew.id,
      shopifyRefundId: `gid://shopify/Refund/${unique}-usd`,
      processedAt: new Date('2026-08-10T12:00:00.000Z'),
      totalRefunded: '20',
      currencyCode: 'USD',
    },
  });
  await prisma.refund.create({
    data: {
      orderId: currentNew.id,
      shopifyRefundId: `gid://shopify/Refund/${unique}-eur`,
      processedAt: new Date('2026-08-10T13:00:00.000Z'),
      totalRefunded: '999',
      currencyCode: 'EUR',
    },
  });

  await createOrder({
    storeId: store.id,
    suffix: 'CURRENT-RETURNING',
    processedAt: '2026-08-11T10:00:00.000Z',
    amount: '50',
    units: 1,
    customerOrderIndex: 3,
  });
  await createOrder({
    storeId: store.id,
    suffix: 'CURRENT-UNKNOWN',
    processedAt: '2026-08-10T15:00:00.000Z',
    amount: '30',
    units: 3,
    customerJourneyReady: false,
    customerOrderIndex: 1,
  });

  await createOrder({
    storeId: store.id,
    suffix: 'COMPARISON-NEW',
    processedAt: '2026-08-08T10:00:00.000Z',
    amount: '40',
    customerOrderIndex: 1,
  });
  await createOrder({
    storeId: store.id,
    suffix: 'COMPARISON-RETURNING',
    processedAt: '2026-08-09T10:00:00.000Z',
    amount: '60',
    units: 2,
    customerOrderIndex: 2,
  });
  await createOrder({
    storeId: store.id,
    suffix: 'COMPARISON-UNKNOWN',
    processedAt: '2026-08-08T16:00:00.000Z',
    amount: '20',
    customerJourneyReady: true,
    customerOrderIndex: null,
  });

  await createOrder({
    storeId: store.id,
    suffix: 'TEST',
    processedAt: '2026-08-10T18:00:00.000Z',
    amount: '9000',
    isTest: true,
  });
  await createOrder({
    storeId: store.id,
    suffix: 'CANCELLED',
    processedAt: '2026-08-10T19:00:00.000Z',
    amount: '8000',
    cancelledAt: '2026-08-10T20:00:00.000Z',
  });
  await createOrder({
    storeId: store.id,
    suffix: 'EUR',
    processedAt: '2026-08-10T21:00:00.000Z',
    amount: '7000',
    currencyCode: 'EUR',
  });

  return store;
}

async function cleanup(storeId: string) {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((order) => order.id);
  if (orderIds.length) {
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('CommerceAnalyticsReadRepository', () => {
  it('matches the established JS order and customer analytics semantics', async () => {
    const store = await fixture();
    const repository = new AnalyticsRepository();
    const storeContext = await repository.getStoreContext(store.id);
    expect(storeContext).not.toBeNull();
    if (!storeContext) throw new Error('fixture store missing');

    const windows = resolveAnalyticsWindows(
      { from: '2026-08-10', to: '2026-08-11', days: 30 },
      'UTC',
    );
    const legacy = new CommerceAnalyticsService(repository);
    const optimized = new CommerceAnalyticsService(
      repository,
      new CommerceAnalyticsReadRepository(),
    );

    expect(await optimized.summary(storeContext, windows)).toEqual(
      await legacy.summary(storeContext, windows),
    );
    expect(await optimized.customers(storeContext, windows)).toEqual(
      await legacy.customers(storeContext, windows),
    );
  });
});
