import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { IntelligenceCommerceReadRepository } from '../../../src/modules/intelligence/intelligence-commerce.read.repository.js';
import {
  buildProductEvidence,
  buildProductEvidenceFromAggregates,
} from '../../../src/modules/intelligence/intelligence.metrics.js';
import { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function fixture() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Intelligence commerce parity',
      myshopifyDomain: `intelligence-commerce-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);

  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      shopifyProductId: `gid://shopify/Product/${unique}`,
      title: 'Core tee',
      status: 'ACTIVE',
    },
  });
  const costedVariant = await prisma.productVariant.create({
    data: {
      storeId: store.id,
      productId: product.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${unique}-costed`,
      title: 'Costed',
    },
  });
  const uncoveredVariant = await prisma.productVariant.create({
    data: {
      storeId: store.id,
      productId: product.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${unique}-uncovered`,
      title: 'Uncovered',
    },
  });

  await prisma.variantCost.createMany({
    data: [
      {
        variantId: costedVariant.id,
        amount: '40',
        currency: 'USD',
        source: 'MANUAL',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveUntil: new Date('2026-08-20T00:00:00.000Z'),
      },
      {
        variantId: costedVariant.id,
        amount: '50',
        currency: 'USD',
        source: 'MANUAL',
        effectiveFrom: new Date('2026-08-20T00:00:00.000Z'),
      },
    ],
  });

  async function createOrder(input: {
    suffix: string;
    processedAt: string | null;
    shopifyCreatedAt: string;
    currency?: string;
    isTest?: boolean;
    cancelledAt?: string | null;
  }) {
    return prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: `gid://shopify/Order/${unique}-${input.suffix}`,
        name: `#${input.suffix}`,
        shopifyCreatedAt: new Date(input.shopifyCreatedAt),
        processedAt: input.processedAt ? new Date(input.processedAt) : null,
        currencyCode: input.currency ?? 'USD',
        isTest: input.isTest ?? false,
        cancelledAt: input.cancelledAt ? new Date(input.cancelledAt) : null,
      },
    });
  }

  const firstOrder = await createOrder({
    suffix: 'first',
    processedAt: '2026-08-15T10:00:00.000Z',
    // Proves processedAt owns the demand cohort even when createdAt is stale.
    shopifyCreatedAt: '2026-01-01T10:00:00.000Z',
  });
  const secondOrder = await createOrder({
    suffix: 'second',
    processedAt: '2026-08-22T10:00:00.000Z',
    shopifyCreatedAt: '2026-08-22T09:00:00.000Z',
  });
  const fallbackDateOrder = await createOrder({
    suffix: 'fallback',
    processedAt: null,
    shopifyCreatedAt: '2026-08-25T10:00:00.000Z',
  });

  const firstLine = await prisma.orderLineItem.create({
    data: {
      orderId: firstOrder.id,
      productId: product.id,
      variantId: costedVariant.id,
      shopifyLineItemId: `gid://shopify/LineItem/${unique}-first`,
      shopifyProductId: product.shopifyProductId,
      shopifyVariantId: costedVariant.shopifyVariantId,
      title: product.title,
      variantTitle: costedVariant.title,
      quantity: 3,
      currentQuantity: 1,
      discountedTotal: '300',
    },
  });
  const firstRefund = await prisma.refund.create({
    data: {
      orderId: firstOrder.id,
      shopifyRefundId: `gid://shopify/Refund/${unique}-first`,
      processedAt: new Date('2026-08-16T00:00:00.000Z'),
      totalRefunded: '200',
      currencyCode: 'USD',
    },
  });
  await prisma.refundLineItem.createMany({
    data: [
      {
        refundId: firstRefund.id,
        orderLineItemId: firstLine.id,
        quantity: 1,
        restocked: true,
        subtotal: '100',
      },
      {
        refundId: firstRefund.id,
        orderLineItemId: firstLine.id,
        quantity: 1,
        restocked: false,
        subtotal: '100',
      },
    ],
  });

  await prisma.orderLineItem.createMany({
    data: [
      {
        orderId: secondOrder.id,
        productId: product.id,
        variantId: costedVariant.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-second`,
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: costedVariant.shopifyVariantId,
        title: product.title,
        variantTitle: costedVariant.title,
        quantity: 2,
        currentQuantity: 2,
        discountedTotal: '200',
      },
      {
        orderId: fallbackDateOrder.id,
        productId: product.id,
        variantId: uncoveredVariant.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-fallback`,
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: uncoveredVariant.shopifyVariantId,
        title: product.title,
        variantTitle: uncoveredVariant.title,
        quantity: 1,
        currentQuantity: 1,
        discountedTotal: '100',
      },
    ],
  });

  // All of these must be excluded from the evidence window.
  for (const ignored of [
    await createOrder({
      suffix: 'test',
      processedAt: '2026-08-18T10:00:00.000Z',
      shopifyCreatedAt: '2026-08-18T10:00:00.000Z',
      isTest: true,
    }),
    await createOrder({
      suffix: 'cancelled',
      processedAt: '2026-08-18T11:00:00.000Z',
      shopifyCreatedAt: '2026-08-18T11:00:00.000Z',
      cancelledAt: '2026-08-19T00:00:00.000Z',
    }),
    await createOrder({
      suffix: 'eur',
      processedAt: '2026-08-18T12:00:00.000Z',
      shopifyCreatedAt: '2026-08-18T12:00:00.000Z',
      currency: 'EUR',
    }),
    await createOrder({
      suffix: 'outside',
      processedAt: '2026-07-01T10:00:00.000Z',
      shopifyCreatedAt: '2026-07-01T10:00:00.000Z',
    }),
  ]) {
    await prisma.orderLineItem.create({
      data: {
        orderId: ignored.id,
        productId: product.id,
        variantId: costedVariant.id,
        shopifyLineItemId: `gid://shopify/LineItem/${unique}-${ignored.name}`,
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: costedVariant.shopifyVariantId,
        title: product.title,
        quantity: 99,
        currentQuantity: 99,
        discountedTotal: '9900',
      },
    });
  }

  return { store, product };
}

async function cleanup(storeId: string) {
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

  const variants = await prisma.productVariant.findMany({
    where: { storeId },
    select: { id: true },
  });
  const variantIds = variants.map((variant) => variant.id);
  if (variantIds.length > 0) {
    await prisma.variantCost.deleteMany({ where: { variantId: { in: variantIds } } });
  }
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('IntelligenceCommerceReadRepository', () => {
  it('matches raw product economics and historical-cost semantics with one row per product', async () => {
    const { store, product } = await fixture();
    const repository = new IntelligenceRepository();
    const compactRepository = new IntelligenceCommerceReadRepository();
    const from = new Date('2026-08-10T00:00:00.000Z');
    const to = new Date('2026-08-31T23:59:59.999Z');

    const rawRows = await repository.getCommerceRows(store.id, from, to);
    const variantIds = [
      ...new Set(
        rawRows
          .map((row) => row.variantId)
          .filter((variantId): variantId is string => variantId !== null),
      ),
    ];
    const [costRows, compactRows] = await Promise.all([
      repository.getVariantCosts(store.id, variantIds, from, to),
      compactRepository.getProductEvidenceAggregates({
        storeId: store.id,
        currency: 'USD',
        from,
        to,
      }),
    ]);

    expect(rawRows).toHaveLength(3);
    expect(compactRows).toHaveLength(1);
    expect(compactRows[0]).toMatchObject({
      productId: product.id,
      sourceOrderLineCount: 3,
      soldUnits: 6,
      refundedUnits: 2,
      restockedUnits: 1,
      netUnits: 4,
      cogsUnits: 5,
      revenue: 600,
      refunds: 200,
      cogs: 180,
      costCoveredUnits: 4,
    });

    const shared = {
      mappings: [],
      inventoryRows: [],
      metaRows: [],
      storeCurrency: 'USD',
      inventoryTrusted: false,
      windowDays: 28,
    } as const;
    const rawEvidence = buildProductEvidence({
      ...shared,
      commerceRows: rawRows,
      costRows,
    });
    const compactEvidence = buildProductEvidenceFromAggregates({
      ...shared,
      commerceRows: compactRows,
    });

    expect(compactEvidence).toEqual(rawEvidence);
    expect(compactEvidence.products[0]).toMatchObject({
      entityId: product.id,
      revenue: 600,
      netRevenue: 400,
      units: 4,
      costCoverage: 0.8,
      contributionBeforeAds: 220,
      contributionAfterAds: 220,
    });
  });
});
