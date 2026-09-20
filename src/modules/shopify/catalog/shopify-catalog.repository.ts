import { prisma } from '../../../lib/prisma.js';
import { enqueueCommerceEntityPixelRepairs } from '../../pixel/pixel-source-invalidation.js';
import type { ShopifyCollection, ShopifyProduct, ShopifyVariant } from '../shopify.schema.js';
import {
  bulkUpsertCollections,
  bulkUpsertInventoryItems,
  bulkUpsertProducts,
  bulkUpsertVariants,
} from '../shared/shopify-bulk-write.js';

const CATALOG_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Full-sync persistence optimized for page-sized Shopify payloads.
 * Webhook reconciliation keeps using the single-record methods in ShopifyRepository.
 *
 * Pixel repair generation is delegated to the Pixel source-invalidation boundary. This repository
 * owns commerce persistence only; the small amount of raw SQL required by repair fencing no longer
 * leaks into Shopify catalog code.
 */
export class ShopifyCatalogRepository {
  async persistProducts(storeId: string, products: ShopifyProduct[]): Promise<void> {
    if (products.length === 0) return;

    const ids = products.map((product) => product.id);
    await prisma.$transaction(async (tx) => {
      await bulkUpsertProducts(tx, storeId, products);
      await enqueueCommerceEntityPixelRepairs(storeId, tx, { productIds: ids });
    }, CATALOG_TRANSACTION_OPTIONS);
  }

  async persistVariants(storeId: string, variants: ShopifyVariant[]): Promise<boolean> {
    if (variants.length === 0) return true;

    const variantExternalIds = variants.map((variant) => variant.id);
    const persisted = await prisma.$transaction(async (tx) => {
      const productExternalIds = [...new Set(variants.map((variant) => variant.product.id))];
      const products = await tx.product.findMany({
        where: { storeId, shopifyProductId: { in: productExternalIds }, deletedAt: null },
        select: { id: true, shopifyProductId: true },
      });

      const productMap = new Map(products.map((product) => [product.shopifyProductId, product.id]));
      if (productExternalIds.some((id) => !productMap.has(id))) return false;

      await bulkUpsertVariants(tx, storeId, variants, productMap);

      const persistedVariants = await tx.productVariant.findMany({
        where: { storeId, shopifyVariantId: { in: variantExternalIds } },
        select: { id: true, shopifyVariantId: true },
      });
      if (persistedVariants.length !== variants.length) {
        await enqueueCommerceEntityPixelRepairs(storeId, tx, { variantIds: variantExternalIds });
        return false;
      }

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

      await tx.variantOption.deleteMany({ where: { variantId: { in: persistedIds } } });
      if (optionRows.length > 0) {
        await tx.variantOption.createMany({ data: optionRows });
      }

      await bulkUpsertInventoryItems(tx, storeId, variants, persistedMap);

      const inventoryItemCount = await tx.inventoryItem.count({
        where: { storeId, variantId: { in: persistedIds }, deletedAt: null },
      });

      await enqueueCommerceEntityPixelRepairs(storeId, tx, { variantIds: variantExternalIds });
      return inventoryItemCount === persistedIds.length;
    }, CATALOG_TRANSACTION_OPTIONS);

    if (!persisted) return false;

    // Cost history is not part of Pixel entity resolution. Persist it after the identity+repair
    // transaction so a cost-write failure cannot leave successfully committed identities without
    // a repair generation.
    await this.persistShopifyCosts(storeId, variants);
    return true;
  }

  async persistShopifyCosts(storeId: string, variants: ShopifyVariant[]): Promise<void> {
    const withCost = variants.filter((variant) => variant.inventoryItem.unitCost != null);
    if (withCost.length === 0) return;

    const externalIds = withCost.map((variant) => variant.id);
    const persistedVariants = await prisma.productVariant.findMany({
      where: { storeId, shopifyVariantId: { in: externalIds }, deletedAt: null },
      select: { id: true, shopifyVariantId: true },
    });
    const variantMap = new Map(
      persistedVariants.map((variant) => [variant.shopifyVariantId, variant.id]),
    );
    const currentCosts = await prisma.variantCost.findMany({
      where: {
        variantId: { in: persistedVariants.map((variant) => variant.id) },
        source: 'SHOPIFY',
        effectiveUntil: null,
      },
      select: { id: true, variantId: true, amount: true, currency: true },
    });
    const currentByVariant = new Map(currentCosts.map((cost) => [cost.variantId, cost]));

    const changes = withCost.flatMap((variant) => {
      const variantId = variantMap.get(variant.id);
      const cost = variant.inventoryItem.unitCost;
      if (!variantId || !cost) return [];

      const current = currentByVariant.get(variantId);
      if (
        current &&
        current.amount.toString() === cost.amount &&
        current.currency === cost.currencyCode
      ) {
        return [];
      }

      return [{ variantId, cost, currentId: current?.id ?? null }];
    });
    if (changes.length === 0) return;

    const effectiveFrom = new Date();
    await prisma.$transaction(async (tx) => {
      const currentIds = changes.flatMap((change) => (change.currentId ? [change.currentId] : []));
      if (currentIds.length > 0) {
        await tx.variantCost.updateMany({
          where: { id: { in: currentIds } },
          data: { effectiveUntil: effectiveFrom },
        });
      }
      await tx.variantCost.createMany({
        data: changes.map((change) => ({
          variantId: change.variantId,
          amount: change.cost.amount,
          currency: change.cost.currencyCode,
          source: 'SHOPIFY',
          effectiveFrom,
        })),
      });
    });
  }

  async persistCollections(storeId: string, collections: ShopifyCollection[]): Promise<void> {
    if (collections.length === 0) return;
    const collectionIds = collections.map((collection) => collection.id);

    await prisma.$transaction(async (tx) => {
      await bulkUpsertCollections(tx, storeId, collections);
      await enqueueCommerceEntityPixelRepairs(storeId, tx, { collectionIds });
    }, CATALOG_TRANSACTION_OPTIONS);
  }

  async replaceCollectionProducts(
    storeId: string,
    shopifyCollectionId: string,
    shopifyProductIds: string[],
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const [collection, products] = await Promise.all([
        tx.collection.findUnique({
          where: { storeId_shopifyCollectionId: { storeId, shopifyCollectionId } },
          select: { id: true },
        }),
        shopifyProductIds.length
          ? tx.product.findMany({
              where: { storeId, shopifyProductId: { in: shopifyProductIds }, deletedAt: null },
              select: { id: true, shopifyProductId: true },
            })
          : Promise.resolve([]),
      ]);
      if (!collection) return false;
      if (products.length !== new Set(shopifyProductIds).size) return false;

      await tx.productCollection.deleteMany({ where: { collectionId: collection.id } });
      if (products.length > 0) {
        const productByExternalId = new Map(
          products.map((product) => [product.shopifyProductId, product.id]),
        );
        await tx.productCollection.createMany({
          data: shopifyProductIds.map((externalId, index) => ({
            collectionId: collection.id,
            productId: productByExternalId.get(externalId)!,
            position: index + 1,
          })),
          skipDuplicates: true,
        });
      }
      await enqueueCommerceEntityPixelRepairs(storeId, tx, {
        collectionIds: [shopifyCollectionId],
      });
      return true;
    }, CATALOG_TRANSACTION_OPTIONS);
  }

  async markMissingCatalogDeleted(
    storeId: string,
    activeShopifyProductIds: string[],
    activeShopifyVariantIds: string[],
  ): Promise<{ products: number; variants: number }> {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const [missingVariants, missingProducts] = await Promise.all([
        tx.productVariant.findMany({
          where: {
            storeId,
            deletedAt: null,
            ...(activeShopifyVariantIds.length > 0
              ? { shopifyVariantId: { notIn: activeShopifyVariantIds } }
              : {}),
          },
          select: { id: true, shopifyVariantId: true },
        }),
        tx.product.findMany({
          where: {
            storeId,
            deletedAt: null,
            ...(activeShopifyProductIds.length > 0
              ? { shopifyProductId: { notIn: activeShopifyProductIds } }
              : {}),
          },
          select: { id: true, shopifyProductId: true },
        }),
      ]);
      const missingVariantIds = missingVariants.map((variant) => variant.id);
      if (missingVariantIds.length > 0) {
        await tx.inventoryItem.updateMany({
          where: { storeId, variantId: { in: missingVariantIds } },
          data: { deletedAt: now },
        });
        await tx.productVariant.updateMany({
          where: { id: { in: missingVariantIds } },
          data: { deletedAt: now },
        });
      }

      if (missingProducts.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: missingProducts.map((product) => product.id) } },
          data: { deletedAt: now },
        });
      }

      await enqueueCommerceEntityPixelRepairs(storeId, tx, {
        productIds: missingProducts.map((product) => product.shopifyProductId),
        variantIds: missingVariants.map((variant) => variant.shopifyVariantId),
      });
      return { products: missingProducts.length, variants: missingVariants.length };
    }, CATALOG_TRANSACTION_OPTIONS);
  }

  async markMissingCollectionsDeleted(storeId: string, activeIds: string[]): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const missing = await tx.collection.findMany({
        where: {
          storeId,
          deletedAt: null,
          ...(activeIds.length > 0 ? { shopifyCollectionId: { notIn: activeIds } } : {}),
        },
        select: { id: true, shopifyCollectionId: true },
      });
      if (missing.length === 0) return 0;

      await tx.collection.updateMany({
        where: { id: { in: missing.map((collection) => collection.id) } },
        data: { deletedAt: new Date() },
      });
      await enqueueCommerceEntityPixelRepairs(storeId, tx, {
        collectionIds: missing.map((collection) => collection.shopifyCollectionId),
      });
      return missing.length;
    }, CATALOG_TRANSACTION_OPTIONS);
  }

  enqueuePixelResolutionRepairs(storeId: string, productExternalId?: string) {
    return enqueueCommerceEntityPixelRepairs(
      storeId,
      prisma,
      productExternalId ? { productIds: [productExternalId] } : undefined,
    );
  }
}
