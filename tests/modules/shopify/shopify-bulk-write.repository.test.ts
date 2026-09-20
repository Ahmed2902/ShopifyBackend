import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../../src/generated/prisma/client.js';
import { prisma } from '../../../src/lib/prisma.js';
import type {
  ShopifyCollection,
  ShopifyProduct,
  ShopifyVariant,
} from '../../../src/modules/shopify/shopify.schema.js';
import {
  bulkUpsertCollections,
  bulkUpsertInventoryItems,
  bulkUpsertInventoryLevels,
  bulkUpsertProducts,
  bulkUpsertVariants,
} from '../../../src/modules/shopify/shared/shopify-bulk-write.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

function product(id: string, title = `Product ${id}`): ShopifyProduct {
  return {
    id,
    title,
    handle: `product-${id}`,
    productType: 'Apparel',
    vendor: 'Stride Test',
    tags: ['bulk', 'sync'],
    status: 'ACTIVE',
    totalInventory: 10,
    tracksInventory: true,
    publishedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function variant(id: string, productId: string): ShopifyVariant {
  return {
    id,
    title: 'Default',
    displayName: `Variant ${id}`,
    sku: `SKU-${id}`,
    barcode: null,
    price: '49.99',
    compareAtPrice: '59.99',
    position: 1,
    availableForSale: true,
    inventoryQuantity: 10,
    inventoryPolicy: 'DENY',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    selectedOptions: [{ name: 'Title', value: 'Default' }],
    product: { id: productId },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      sku: `SKU-${id}`,
      tracked: true,
      requiresShipping: true,
      unitCost: { amount: '20.00', currencyCode: 'USD' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  };
}

function collection(id: string, title = `Collection ${id}`): ShopifyCollection {
  return {
    id,
    title,
    handle: `collection-${id}`,
    descriptionHtml: '<p>Bulk sync</p>',
    sortOrder: 'MANUAL',
    image: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

async function createStore() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Bulk Sync Store',
      myshopifyDomain: `bulk-sync-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  return store;
}

async function cleanup(storeId: string) {
  const items = await prisma.inventoryItem.findMany({ where: { storeId }, select: { id: true } });
  const itemIds = items.map((item) => item.id);
  if (itemIds.length > 0) {
    await prisma.inventorySnapshot.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryLevelCurrent.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
  }
  await prisma.inventoryItem.deleteMany({ where: { storeId } });
  await prisma.variantOption.deleteMany({ where: { variant: { storeId } } });
  await prisma.variantCost.deleteMany({ where: { variant: { storeId } } });
  await prisma.productCollection.deleteMany({ where: { product: { storeId } } });
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.collection.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.location.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describe('Shopify bulk write helpers', () => {
  it('uses one SQL execution for a page instead of one call per row', async () => {
    const executeRaw = vi.fn().mockResolvedValue(50);
    const db = { $executeRaw: executeRaw } as unknown as Pick<
      Prisma.TransactionClient,
      '$executeRaw'
    >;
    const storeId = randomUUID();
    const products = Array.from({ length: 50 }, (_, index) =>
      product(`gid://shopify/Product/${index}`),
    );

    await bulkUpsertProducts(db, storeId, products);

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});

describeDatabase('Shopify bulk write SQL', () => {
  it('upserts catalog and inventory pages while preserving one row per Shopify identity', async () => {
    const store = await createStore();
    const firstProduct = product('gid://shopify/Product/1', 'Original title');
    const secondProduct = product('gid://shopify/Product/2');

    await prisma.$transaction((tx) => bulkUpsertProducts(tx, store.id, [firstProduct, secondProduct]));
    await prisma.$transaction((tx) =>
      bulkUpsertProducts(tx, store.id, [product(firstProduct.id, 'Updated title'), secondProduct]),
    );

    const products = await prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { shopifyProductId: 'asc' },
    });
    expect(products).toHaveLength(2);
    expect(products[0]?.title).toBe('Updated title');
    expect(products[0]?.tags).toEqual(['bulk', 'sync']);

    const productMap = new Map(products.map((row) => [row.shopifyProductId, row.id]));
    const firstVariant = variant('gid://shopify/ProductVariant/1', firstProduct.id);
    const secondVariant = variant('gid://shopify/ProductVariant/2', secondProduct.id);

    await prisma.$transaction(async (tx) => {
      await bulkUpsertVariants(tx, store.id, [firstVariant, secondVariant], productMap);
    });
    const variants = await prisma.productVariant.findMany({
      where: { storeId: store.id },
      orderBy: { shopifyVariantId: 'asc' },
    });
    expect(variants).toHaveLength(2);

    const variantMap = new Map(variants.map((row) => [row.shopifyVariantId, row.id]));
    await prisma.$transaction(async (tx) => {
      await bulkUpsertInventoryItems(tx, store.id, [firstVariant, secondVariant], variantMap);
    });
    await prisma.$transaction(async (tx) => {
      await bulkUpsertInventoryItems(
        tx,
        store.id,
        [
          {
            ...firstVariant,
            inventoryItem: { ...firstVariant.inventoryItem, sku: 'UPDATED-SKU' },
          },
          secondVariant,
        ],
        variantMap,
      );
    });

    const inventoryItems = await prisma.inventoryItem.findMany({
      where: { storeId: store.id },
      orderBy: { shopifyInventoryItemId: 'asc' },
    });
    expect(inventoryItems).toHaveLength(2);
    expect(inventoryItems[0]?.sku).toBe('UPDATED-SKU');

    await prisma.$transaction((tx) =>
      bulkUpsertCollections(tx, store.id, [collection('gid://shopify/Collection/1', 'First')]),
    );
    await prisma.$transaction((tx) =>
      bulkUpsertCollections(tx, store.id, [collection('gid://shopify/Collection/1', 'Updated')]),
    );
    expect(
      await prisma.collection.findMany({ where: { storeId: store.id }, select: { title: true } }),
    ).toEqual([{ title: 'Updated' }]);

    const location = await prisma.location.create({
      data: {
        storeId: store.id,
        shopifyLocationId: 'gid://shopify/Location/1',
        name: 'Warehouse',
      },
    });
    const inventoryItem = inventoryItems[0]!;
    const now = new Date('2026-09-20T00:00:00.000Z');

    await prisma.$transaction((tx) =>
      bulkUpsertInventoryLevels(
        tx,
        [
          {
            inventoryItemId: inventoryItem.id,
            locationId: location.id,
            available: 5,
            incoming: 1,
            committed: 2,
            onHand: 7,
            reserved: 0,
            damaged: 0,
            safetyStock: 0,
            qualityControl: 0,
            sourceUpdatedAt: now,
          },
        ],
        now,
      ),
    );
    await prisma.$transaction((tx) =>
      bulkUpsertInventoryLevels(
        tx,
        [
          {
            inventoryItemId: inventoryItem.id,
            locationId: location.id,
            available: 9,
            incoming: 1,
            committed: 0,
            onHand: 9,
            reserved: 0,
            damaged: 0,
            safetyStock: 0,
            qualityControl: 0,
            sourceUpdatedAt: now,
          },
        ],
        now,
      ),
    );

    const levels = await prisma.inventoryLevelCurrent.findMany({
      where: { inventoryItemId: inventoryItem.id, locationId: location.id },
    });
    expect(levels).toHaveLength(1);
    expect(levels[0]?.available).toBe(9);
  });
});
