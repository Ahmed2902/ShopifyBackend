import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyMetricsRepository } from '../../../src/modules/shopify/read/shopify-metrics.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function fixture() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Metrics Store',
      myshopifyDomain: `metrics-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);

  const active = await prisma.product.create({
    data: { storeId: store.id, shopifyProductId: `gid://shopify/Product/${unique}-1`, title: 'Classic Hoodie', status: 'ACTIVE', tracksInventory: true },
  });
  await prisma.product.create({
    data: { storeId: store.id, shopifyProductId: `gid://shopify/Product/${unique}-2`, title: 'Draft Product', status: 'DRAFT' },
  });
  await prisma.product.create({
    data: { storeId: store.id, shopifyProductId: `gid://shopify/Product/${unique}-3`, title: 'Archived Product', status: 'ARCHIVED' },
  });

  const black = await prisma.productVariant.create({
    data: { storeId: store.id, productId: active.id, shopifyVariantId: `gid://shopify/ProductVariant/${unique}-black`, title: 'Black / XL', sku: 'HOOD-BLK-XL', price: '59' },
  });
  const white = await prisma.productVariant.create({
    data: { storeId: store.id, productId: active.id, shopifyVariantId: `gid://shopify/ProductVariant/${unique}-white`, title: 'White / XL', sku: 'HOOD-WHT-XL', price: '59' },
  });
  const tracked = await prisma.inventoryItem.create({
    data: { storeId: store.id, variantId: black.id, shopifyInventoryItemId: `gid://shopify/InventoryItem/${unique}-1`, tracked: true, sku: black.sku },
  });
  await prisma.inventoryItem.create({
    data: { storeId: store.id, variantId: white.id, shopifyInventoryItemId: `gid://shopify/InventoryItem/${unique}-2`, tracked: false, sku: white.sku },
  });
  const location = await prisma.location.create({
    data: { storeId: store.id, shopifyLocationId: `gid://shopify/Location/${unique}`, name: 'Warehouse', isActive: true },
  });
  await prisma.inventoryLevelCurrent.create({
    data: { inventoryItemId: tracked.id, locationId: location.id, available: 2, onHand: 6, committed: 4, incoming: 10, reserved: 1 },
  });

  const importedOrder = await prisma.order.create({
    data: {
      storeId: store.id,
      shopifyOrderId: `gid://shopify/Order/${unique}-1`,
      name: '#1001',
      shopifyCreatedAt: new Date('2026-01-01T10:00:00Z'),
      processedAt: new Date('2026-08-10T10:00:00Z'),
      sourceName: 'web',
      isTest: false,
      currencyCode: 'USD',
      displayFinancialStatus: 'PAID',
      currentSubtotalLineItemsQuantity: 3,
      currentTotalAmount: '177',
      currentTotalDiscountsAmount: '0',
      lineItems: {
        create: {
          productId: active.id,
          variantId: black.id,
          shopifyLineItemId: `gid://shopify/LineItem/${unique}-1`,
          shopifyProductId: active.shopifyProductId,
          shopifyVariantId: black.shopifyVariantId,
          sku: black.sku,
          title: active.title,
          variantTitle: black.title,
          quantity: 3,
          currentQuantity: 2,
          discountedTotal: '177',
        },
      },
    },
    include: { lineItems: true },
  });
  const refund = await prisma.refund.create({
    data: { orderId: importedOrder.id, shopifyRefundId: `gid://shopify/Refund/${unique}`, processedAt: new Date('2026-08-11T10:00:00Z'), totalRefunded: '59', currencyCode: 'USD' },
  });
  await prisma.refundLineItem.create({
    data: { refundId: refund.id, orderLineItemId: importedOrder.lineItems[0]!.id, quantity: 1, subtotal: '59', price: '59' },
  });

  await prisma.order.create({
    data: {
      storeId: store.id,
      shopifyOrderId: `gid://shopify/Order/${unique}-test`,
      name: '#TEST',
      shopifyCreatedAt: new Date('2026-08-10T12:00:00Z'),
      processedAt: new Date('2026-08-10T12:00:00Z'),
      isTest: true,
      currencyCode: 'USD',
      currentSubtotalLineItemsQuantity: 99,
      currentTotalAmount: '9999',
    },
  });

  return { store, active, black };
}

async function cleanup(storeId: string) {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((row) => row.id);
  const refunds = orderIds.length ? await prisma.refund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } }) : [];
  if (refunds.length) await prisma.refundLineItem.deleteMany({ where: { refundId: { in: refunds.map((row) => row.id) } } });
  if (orderIds.length) {
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  const inventoryItems = await prisma.inventoryItem.findMany({ where: { storeId }, select: { id: true } });
  if (inventoryItems.length) await prisma.inventoryLevelCurrent.deleteMany({ where: { inventoryItemId: { in: inventoryItems.map((row) => row.id) } } });
  await prisma.inventoryItem.deleteMany({ where: { storeId } });
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.location.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('ShopifyMetricsRepository', () => {
  it('summarizes catalog, inventory and non-test commerce state', async () => {
    const data = await fixture();
    const repository = new ShopifyMetricsRepository();

    const summary = await repository.getSummary(data.store.id, {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-20T00:00:00.000Z',
      lowStockBelow: 5,
    });

    expect(summary).toMatchObject({
      catalog: { products: 3, activeProducts: 1, draftProducts: 1, archivedProducts: 1, variants: 2, trackedInventoryItems: 1, untrackedInventoryItems: 1, activeLocations: 1 },
      inventory: { available: 2, onHand: 6, incoming: 10, committed: 4, lowStockLevels: 1, outOfStockLevels: 0 },
      commerce: { orders: 1, units: 3, totalSales: '177', refunds: 1, refundedAmount: '59' },
    });
  });

  it('uses processedAt for imported demand, excludes test orders and subtracts refunds', async () => {
    const data = await fixture();
    const repository = new ShopifyMetricsRepository();

    const sales = await repository.getProductSales(data.store.id, data.active.id, {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-20T00:00:00.000Z',
    });

    expect(sales).toMatchObject({
      product: { id: data.active.id, title: 'Classic Hoodie' },
      currencyCode: 'USD',
      summary: { orderCount: 1, orderedUnits: 3, currentUnits: 2, refundedUnits: 1, grossSales: '177.00', refundedSales: '59.00', netSales: '118.00' },
      variants: [{ variantId: data.black.id, sku: 'HOOD-BLK-XL', orderedUnits: 3, refundedUnits: 1, netSales: '118.00' }],
      daily: [{ date: '2026-08-10', orderCount: 1, orderedUnits: 3, netSales: '118.00' }],
    });
  });
});
