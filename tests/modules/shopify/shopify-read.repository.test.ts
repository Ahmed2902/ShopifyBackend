import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyReadRepository } from '../../../src/modules/shopify/read/shopify-read.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createFixture(label: string) {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: `${label} Store`,
      myshopifyDomain: `${label.toLowerCase()}-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: 'ciphertext',
          scopes: ['read_products', 'read_inventory', 'read_locations', 'read_orders'],
          apiVersion: '2026-07',
          lastSyncedAt: new Date('2026-08-20T10:00:00.000Z'),
          reconciliationIntervalMinutes: 1440,
          nextReconciliationAt: new Date('2026-08-21T10:00:00.000Z'),
        },
      },
    },
    select: { id: true, shopifyConnection: { select: { id: true } } },
  });
  createdStoreIds.push(store.id);

  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      shopifyProductId: `gid://shopify/Product/${unique}`,
      title: `${label} Hoodie`,
      handle: `${label.toLowerCase()}-hoodie`,
      vendor: label,
      status: 'ACTIVE',
      tracksInventory: true,
      totalInventory: 9,
      shopifyUpdatedAt: new Date('2026-08-20T09:00:00.000Z'),
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      storeId: store.id,
      productId: product.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${unique}`,
      title: 'Large',
      displayName: `${label} Hoodie - Large`,
      sku: `${label.toUpperCase()}-L`,
      price: '59.99',
      availableForSale: true,
      inventoryQuantity: 9,
      options: { create: [{ name: 'Size', value: 'L', position: 1 }] },
    },
  });
  const inventoryItem = await prisma.inventoryItem.create({
    data: {
      storeId: store.id,
      variantId: variant.id,
      shopifyInventoryItemId: `gid://shopify/InventoryItem/${unique}`,
      sku: `${label.toUpperCase()}-L`,
      tracked: true,
    },
  });
  const location = await prisma.location.create({
    data: {
      storeId: store.id,
      shopifyLocationId: `gid://shopify/Location/${unique}`,
      name: `${label} Warehouse`,
      isActive: true,
    },
  });
  await prisma.inventoryLevelCurrent.create({
    data: {
      inventoryItemId: inventoryItem.id,
      locationId: location.id,
      available: 7,
      incoming: 2,
      committed: 1,
      onHand: 9,
      reserved: 1,
      safetyStock: 1,
    },
  });

  const order = await prisma.order.create({
    data: {
      storeId: store.id,
      shopifyOrderId: `gid://shopify/Order/${unique}`,
      name: `#${label}1001`,
      shopifyCreatedAt: new Date('2026-08-20T08:00:00.000Z'),
      sourceName: 'web',
      isTest: label === 'Beta',
      currencyCode: 'USD',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      currentSubtotalLineItemsQuantity: 1,
      currentSubtotalAmount: '59.99',
      currentTotalAmount: '59.99',
      lineItems: {
        create: {
          productId: product.id,
          variantId: variant.id,
          shopifyLineItemId: `gid://shopify/LineItem/${unique}`,
          shopifyProductId: product.shopifyProductId,
          shopifyVariantId: variant.shopifyVariantId,
          sku: variant.sku,
          title: product.title,
          variantTitle: variant.title,
          quantity: 1,
          currentQuantity: 0,
          refundableQuantity: 0,
          originalUnitPrice: '59.99',
          originalTotal: '59.99',
          discountedTotal: '59.99',
          requiresShipping: true,
          restockable: true,
        },
      },
    },
    include: { lineItems: true },
  });
  const refund = await prisma.refund.create({
    data: {
      orderId: order.id,
      shopifyRefundId: `gid://shopify/Refund/${unique}`,
      shopifyCreatedAt: new Date('2026-08-20T09:00:00.000Z'),
      totalRefunded: '59.99',
      currencyCode: 'USD',
    },
  });
  await prisma.refundLineItem.create({
    data: {
      refundId: refund.id,
      orderLineItemId: order.lineItems[0]!.id,
      locationId: location.id,
      shopifyRefundLineId: `gid://shopify/RefundLineItem/${unique}`,
      quantity: 1,
      restocked: true,
      restockType: 'RETURN',
      price: '59.99',
      subtotal: '59.99',
      tax: '0',
    },
  });

  return { store, product, variant, inventoryItem, location, order };
}

async function deleteStore(storeId: string) {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((order) => order.id);
  const refunds = orderIds.length
    ? await prisma.refund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
    : [];
  const refundIds = refunds.map((refund) => refund.id);
  if (refundIds.length) await prisma.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
  if (orderIds.length) {
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }

  const items = await prisma.inventoryItem.findMany({ where: { storeId }, select: { id: true } });
  const itemIds = items.map((item) => item.id);
  if (itemIds.length) {
    await prisma.inventorySnapshot.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryLevelCurrent.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
  }
  await prisma.inventoryItem.deleteMany({ where: { storeId } });

  const variants = await prisma.productVariant.findMany({ where: { storeId }, select: { id: true } });
  if (variants.length) {
    await prisma.variantOption.deleteMany({ where: { variantId: { in: variants.map((row) => row.id) } } });
  }
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.location.deleteMany({ where: { storeId } });

  const connection = await prisma.shopifyConnection.findUnique({ where: { storeId }, select: { id: true } });
  if (connection) {
    await prisma.externalPayload.deleteMany({ where: { syncRun: { shopifyConnectionId: connection.id } } });
    await prisma.syncRun.deleteMany({ where: { shopifyConnectionId: connection.id } });
    await prisma.webhookDelivery.deleteMany({ where: { shopifyConnectionId: connection.id } });
    await prisma.shopifyConnection.delete({ where: { id: connection.id } });
  }
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) await deleteStore(storeId);
});

describeDatabase('ShopifyReadRepository', () => {
  it('keeps product and inventory lists store-scoped and exposes operational inventory', async () => {
    const alpha = await createFixture('Alpha');
    await createFixture('Beta');
    const repository = new ShopifyReadRepository();

    const products = await repository.listProducts(alpha.store.id, {
      page: 1,
      limit: 50,
    });
    expect(products.total).toBe(1);
    expect(products.items[0]).toMatchObject({
      id: alpha.product.id,
      title: 'Alpha Hoodie',
      availableInventory: 7,
      onHandInventory: 9,
      incomingInventory: 2,
      minPrice: '59.99',
      maxPrice: '59.99',
    });

    const inventory = await repository.listInventory(alpha.store.id, {
      page: 1,
      limit: 50,
    });
    expect(inventory.total).toBe(1);
    expect(inventory.items[0]).toMatchObject({
      available: 7,
      location: { id: alpha.location.id },
      inventoryItem: {
        variant: { id: alpha.variant.id, product: { id: alpha.product.id } },
      },
    });
  });

  it('returns product detail with variants, options and per-location inventory without raw provider JSON', async () => {
    const alpha = await createFixture('Alpha');
    const repository = new ShopifyReadRepository();

    const product = await repository.getProduct(alpha.store.id, alpha.product.id);

    expect(product).toMatchObject({
      id: alpha.product.id,
      variants: [
        {
          id: alpha.variant.id,
          price: '59.99',
          options: [{ name: 'Size', value: 'L', position: 1 }],
          inventoryItem: {
            currentLevels: [
              {
                available: 7,
                onHand: 9,
                location: { id: alpha.location.id, name: 'Alpha Warehouse' },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(product)).not.toContain('rawJson');
  });

  it('filters test orders and returns refund detail without customer PII fields', async () => {
    const alpha = await createFixture('Alpha');
    const beta = await createFixture('Beta');
    const repository = new ShopifyReadRepository();

    const productionOrders = await repository.listOrders(alpha.store.id, {
      page: 1,
      limit: 50,
      isTest: false,
    });
    expect(productionOrders.total).toBe(1);
    expect(productionOrders.items[0]).toMatchObject({
      id: alpha.order.id,
      isTest: false,
      refundCount: 1,
      refundedAmount: '59.99',
    });

    const hiddenBeta = await repository.listOrders(beta.store.id, {
      page: 1,
      limit: 50,
      isTest: false,
    });
    expect(hiddenBeta.total).toBe(0);

    const detail = await repository.getOrder(alpha.store.id, alpha.order.id);
    expect(detail).toMatchObject({
      id: alpha.order.id,
      currentTotalAmount: '59.99',
      refunds: [
        {
          totalRefunded: '59.99',
          lineItems: [{ quantity: 1, restocked: true, price: '59.99' }],
        },
      ],
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toMatch(/customer|email|phone/i);
  });

  it('reports connection, data counts and latest history/reconciliation state', async () => {
    const alpha = await createFixture('Alpha');
    await prisma.syncRun.createMany({
      data: [
        {
          provider: 'SHOPIFY',
          shopifyConnectionId: alpha.store.shopifyConnection!.id,
          resourceType: 'OrdersRefunds',
          mode: 'BACKFILL',
          apiVersion: '2026-07',
          status: 'SUCCEEDED',
          startedAt: new Date('2026-08-20T10:00:00.000Z'),
          finishedAt: new Date('2026-08-20T10:01:00.000Z'),
        },
        {
          provider: 'SHOPIFY',
          shopifyConnectionId: alpha.store.shopifyConnection!.id,
          resourceType: 'StoreReconciliation',
          mode: 'PERIODIC',
          apiVersion: '2026-07',
          status: 'SUCCEEDED',
          startedAt: new Date('2026-08-20T11:00:00.000Z'),
          finishedAt: new Date('2026-08-20T11:01:00.000Z'),
        },
      ],
    });
    const repository = new ShopifyReadRepository();

    const status = await repository.getStatus(alpha.store.id);

    expect(status).toMatchObject({
      store: { id: alpha.store.id, myshopifyDomain: expect.stringContaining('alpha-') },
      connection: { status: 'ACTIVE', apiVersion: '2026-07' },
      counts: { products: 1, variants: 1, inventoryLevels: 1, locations: 1, orders: 1 },
      orderHistory: { status: 'SUCCEEDED' },
      reconciliation: { status: 'SUCCEEDED' },
    });
  });
});
