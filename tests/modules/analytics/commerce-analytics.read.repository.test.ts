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
      customerOrderIndex:
        input.customerOrderIndex === undefined ? 1 : input.customerOrderIndex,
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

  const productA = await prisma.product.create({
    data: {
      storeId: store.id,
      shopifyProductId: `gid://shopify/Product/${unique}-a`,
      title: 'Product A',
      status: 'ACTIVE',
    },
  });
  const productB = await prisma.product.create({
    data: {
      storeId: store.id,
      shopifyProductId: `gid://shopify/Product/${unique}-b`,
      title: 'Product B',
      status: 'ACTIVE',
    },
  });
  const variantA = await prisma.productVariant.create({
    data: {
      storeId: store.id,
      productId: productA.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${unique}-a`,
      title: 'Default A',
    },
  });
  const variantB = await prisma.productVariant.create({
    data: {
      storeId: store.id,
      productId: productB.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${unique}-b`,
      title: 'Default B',
    },
  });

  await prisma.variantCost.createMany({
    data: [
      {
        variantId: variantA.id,
        amount: '10',
        currency: 'USD',
        source: 'MANUAL',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveUntil: new Date('2026-08-10T12:00:00.000Z'),
      },
      {
        variantId: variantA.id,
        amount: '12',
        currency: 'USD',
        source: 'MANUAL',
        effectiveFrom: new Date('2026-08-10T12:00:00.000Z'),
      },
    ],
  });

  const currentNew = await createOrder({
    storeId: store.id,
    suffix: 'CURRENT-NEW',
    // shopifyCreatedAt intentionally falls outside the window; processedAt owns demand cohorting.
    shopifyCreatedAt: '2026-01-01T10:00:00.000Z',
    processedAt: '2026-08-10T10:00:00.000Z',
    amount: '100',
    discounts: '10',
    units: 3,
    customerOrderIndex: 1,
  });
  const usdRefund = await prisma.refund.create({
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

  const currentReturning = await createOrder({
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

  const comparisonNew = await createOrder({
    storeId: store.id,
    suffix: 'COMPARISON-NEW',
    processedAt: '2026-08-08T10:00:00.000Z',
    amount: '40',
    customerOrderIndex: 1,
  });
  const comparisonReturning = await createOrder({
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

  const currentALine = await prisma.orderLineItem.create({
    data: {
      orderId: currentNew.id,
      productId: productA.id,
      variantId: variantA.id,
      shopifyLineItemId: `gid://shopify/LineItem/${unique}-current-a`,
      shopifyProductId: productA.shopifyProductId,
      shopifyVariantId: variantA.shopifyVariantId,
      title: productA.title,
      variantTitle: variantA.title,
      quantity: 2,
      currentQuantity: 1,
      discountedTotal: '80',
    },
  });
  await prisma.refundLineItem.create({
    data: {
      refundId: usdRefund.id,
      orderLineItemId: currentALine.id,
      quantity: 1,
      restocked: true,
      subtotal: '30',
    },
  });
  await prisma.orderLineItem.createMany({
    data: [
      {
        orderId: currentNew.id,
        productId: productB.id,
        variantId: variantB.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-current-b`,
        shopifyProductId: productB.shopifyProductId,
        shopifyVariantId: variantB.shopifyVariantId,
        title: productB.title,
        variantTitle: variantB.title,
        quantity: 1,
        currentQuantity: 1,
        discountedTotal: '20',
      },
      {
        orderId: currentReturning.id,
        productId: productA.id,
        variantId: variantA.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-returning-a`,
        shopifyProductId: productA.shopifyProductId,
        shopifyVariantId: variantA.shopifyVariantId,
        title: productA.title,
        variantTitle: variantA.title,
        quantity: 1,
        currentQuantity: 1,
        discountedTotal: '50',
      },
      {
        orderId: comparisonNew.id,
        productId: productA.id,
        variantId: variantA.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-comparison-a`,
        shopifyProductId: productA.shopifyProductId,
        shopifyVariantId: variantA.shopifyVariantId,
        title: productA.title,
        variantTitle: variantA.title,
        quantity: 1,
        currentQuantity: 1,
        discountedTotal: '40',
      },
      {
        orderId: comparisonReturning.id,
        productId: productB.id,
        variantId: variantB.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-comparison-b`,
        shopifyProductId: productB.shopifyProductId,
        shopifyVariantId: variantB.shopifyVariantId,
        title: productB.title,
        variantTitle: variantB.title,
        quantity: 2,
        currentQuantity: 2,
        discountedTotal: '60',
      },
    ],
  });

  return store;
}

async function cleanup(storeId: string) {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((order) => order.id);
  if (orderIds.length) {
    const refunds = await prisma.refund.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    const refundIds = refunds.map((refund) => refund.id);
    if (refundIds.length) {
      await prisma.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
      await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
    }
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  const variants = await prisma.productVariant.findMany({
    where: { storeId },
    select: { id: true },
  });
  const variantIds = variants.map((variant) => variant.id);
  if (variantIds.length) await prisma.variantCost.deleteMany({ where: { variantId: { in: variantIds } } });
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('CommerceAnalyticsReadRepository', () => {
  it('matches the established JS commerce analytics semantics', async () => {
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
    expect(await optimized.profitabilityBase(storeContext, windows)).toEqual(
      await legacy.profitabilityBase(storeContext, windows),
    );
  });
});
