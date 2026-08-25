import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type { ShopifyProduct, ShopifyVariant } from '../shopify.schema.js';

const DB_WRITE_CONCURRENCY = 12;

function optionalDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

async function runBatched<T>(items: T[], task: (item: T) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < items.length; index += DB_WRITE_CONCURRENCY) {
    await Promise.all(items.slice(index, index + DB_WRITE_CONCURRENCY).map(task));
  }
}

function productData(product: ShopifyProduct) {
  return {
    title: product.title,
    handle: product.handle ?? null,
    productType: product.productType ?? null,
    vendor: product.vendor ?? null,
    tags: product.tags,
    status: product.status,
    totalInventory: product.totalInventory ?? null,
    tracksInventory: product.tracksInventory,
    publishedAt: optionalDate(product.publishedAt),
    shopifyCreatedAt: optionalDate(product.createdAt),
    shopifyUpdatedAt: optionalDate(product.updatedAt),
    deletedAt: null,
    rawJson: product as unknown as Prisma.InputJsonValue,
  };
}

function variantData(variant: ShopifyVariant, productId: string) {
  return {
    productId,
    title: variant.title,
    displayName: variant.displayName ?? null,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    price: variant.price ?? null,
    compareAtPrice: variant.compareAtPrice ?? null,
    position: variant.position ?? null,
    availableForSale: variant.availableForSale,
    inventoryQuantity: variant.inventoryQuantity ?? null,
    inventoryPolicy: variant.inventoryPolicy ?? null,
    shopifyCreatedAt: optionalDate(variant.createdAt),
    shopifyUpdatedAt: optionalDate(variant.updatedAt),
    deletedAt: null,
    rawJson: variant as unknown as Prisma.InputJsonValue,
  };
}

function inventoryItemData(variant: ShopifyVariant) {
  const item = variant.inventoryItem;
  return {
    shopifyInventoryItemId: item.id,
    sku: item.sku ?? variant.sku ?? null,
    tracked: item.tracked,
    requiresShipping: item.requiresShipping,
    shopifyCreatedAt: optionalDate(item.createdAt),
    shopifyUpdatedAt: optionalDate(item.updatedAt),
    deletedAt: null,
    rawJson: item as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Full-sync persistence optimized for page-sized Shopify payloads.
 * Webhook reconciliation keeps using the single-record methods in ShopifyRepository.
 */
export class ShopifyCatalogRepository {
  async persistProducts(storeId: string, products: ShopifyProduct[]): Promise<void> {
    if (products.length === 0) return;

    const ids = products.map((product) => product.id);
    const existing = await prisma.product.findMany({
      where: { storeId, shopifyProductId: { in: ids } },
      select: { id: true, shopifyProductId: true },
    });
    const existingByExternalId = new Map(
      existing.map((product) => [product.shopifyProductId, product.id]),
    );

    const newProducts = products.filter((product) => !existingByExternalId.has(product.id));
    if (newProducts.length > 0) {
      await prisma.product.createMany({
        data: newProducts.map((product) => ({
          storeId,
          shopifyProductId: product.id,
          ...productData(product),
        })),
        skipDuplicates: true,
      });
    }

    const updates = products.filter((product) => existingByExternalId.has(product.id));
    await runBatched(updates, (product) =>
      prisma.product.update({
        where: { id: existingByExternalId.get(product.id)! },
        data: productData(product),
        select: { id: true },
      }),
    );
  }

  async persistVariants(storeId: string, variants: ShopifyVariant[]): Promise<boolean> {
    if (variants.length === 0) return true;

    const productExternalIds = [...new Set(variants.map((variant) => variant.product.id))];
    const variantExternalIds = variants.map((variant) => variant.id);

    const [products, existingVariants] = await Promise.all([
      prisma.product.findMany({
        where: { storeId, shopifyProductId: { in: productExternalIds }, deletedAt: null },
        select: { id: true, shopifyProductId: true },
      }),
      prisma.productVariant.findMany({
        where: { storeId, shopifyVariantId: { in: variantExternalIds } },
        select: { id: true, shopifyVariantId: true },
      }),
    ]);

    const productMap = new Map(products.map((product) => [product.shopifyProductId, product.id]));
    if (productExternalIds.some((id) => !productMap.has(id))) return false;

    const existingVariantMap = new Map(
      existingVariants.map((variant) => [variant.shopifyVariantId, variant.id]),
    );
    const newVariants = variants.filter((variant) => !existingVariantMap.has(variant.id));

    if (newVariants.length > 0) {
      await prisma.productVariant.createMany({
        data: newVariants.map((variant) => ({
          storeId,
          shopifyVariantId: variant.id,
          ...variantData(variant, productMap.get(variant.product.id)!),
        })),
        skipDuplicates: true,
      });
    }

    const updates = variants.filter((variant) => existingVariantMap.has(variant.id));
    await runBatched(updates, (variant) =>
      prisma.productVariant.update({
        where: { id: existingVariantMap.get(variant.id)! },
        data: variantData(variant, productMap.get(variant.product.id)!),
        select: { id: true },
      }),
    );

    const persistedVariants = await prisma.productVariant.findMany({
      where: { storeId, shopifyVariantId: { in: variantExternalIds } },
      select: { id: true, shopifyVariantId: true },
    });
    if (persistedVariants.length !== variants.length) return false;

    const persistedMap = new Map(
      persistedVariants.map((variant) => [variant.shopifyVariantId, variant.id]),
    );
    const persistedIds = persistedVariants.map((variant) => variant.id);
    const optionRows = variants.flatMap((variant) => {
      const variantId = persistedMap.get(variant.id)!;
      return variant.selectedOptions.map((option, index) => ({
        variantId,
        name: option.name,
        value: option.value,
        position: index + 1,
      }));
    });

    await prisma.variantOption.deleteMany({ where: { variantId: { in: persistedIds } } });
    if (optionRows.length > 0) {
      await prisma.variantOption.createMany({ data: optionRows });
    }

    const existingItems = await prisma.inventoryItem.findMany({
      where: { variantId: { in: persistedIds } },
      select: { id: true, variantId: true },
    });
    const itemByVariantId = new Map(existingItems.map((item) => [item.variantId, item.id]));
    const newItems = variants.filter(
      (variant) => !itemByVariantId.has(persistedMap.get(variant.id)!),
    );

    if (newItems.length > 0) {
      await prisma.inventoryItem.createMany({
        data: newItems.map((variant) => ({
          storeId,
          variantId: persistedMap.get(variant.id)!,
          ...inventoryItemData(variant),
        })),
        skipDuplicates: true,
      });
    }

    const itemUpdates = variants.filter((variant) =>
      itemByVariantId.has(persistedMap.get(variant.id)!),
    );
    await runBatched(itemUpdates, (variant) => {
      const variantId = persistedMap.get(variant.id)!;
      return prisma.inventoryItem.update({
        where: { id: itemByVariantId.get(variantId)! },
        data: inventoryItemData(variant),
        select: { id: true },
      });
    });

    const inventoryItemCount = await prisma.inventoryItem.count({
      where: { storeId, variantId: { in: persistedIds }, deletedAt: null },
    });
    return inventoryItemCount === persistedIds.length;
  }
}
