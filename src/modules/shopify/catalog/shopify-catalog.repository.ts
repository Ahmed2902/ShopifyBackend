import { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type {
  ShopifyCollection,
  ShopifyProduct,
  ShopifyVariant,
} from '../shopify.schema.js';

const DB_WRITE_CONCURRENCY = 12;

type RepairSqlClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

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

function collectionData(collection: ShopifyCollection) {
  return {
    title: collection.title,
    handle: collection.handle ?? null,
    descriptionHtml: collection.descriptionHtml ?? null,
    sortOrder: collection.sortOrder ?? null,
    imageUrl: collection.image?.url ?? null,
    shopifyUpdatedAt: optionalDate(collection.updatedAt),
    deletedAt: null,
    rawJson: collection as unknown as Prisma.InputJsonValue,
  };
}

async function enqueuePixelResolutionRepairsWith(
  db: RepairSqlClient,
  storeId: string,
  productExternalId?: string,
) {
  const evidencePredicate = productExternalId
    ? Prisma.sql`(
        e."productExternalId" = ${productExternalId}
        OR e."variantExternalId" IN (
          SELECT pv."shopifyVariantId"
          FROM "ProductVariant" pv
          INNER JOIN "Product" p ON p."id" = pv."productId"
          WHERE pv."storeId" = ${storeId}::uuid
            AND p."storeId" = ${storeId}::uuid
            AND p."shopifyProductId" = ${productExternalId}
        )
      )`
    : Prisma.sql`(
        e."productExternalId" IS NOT NULL
        OR e."variantExternalId" IS NOT NULL
        OR e."collectionExternalId" IS NOT NULL
      )`;

  return db.$executeRaw`
    INSERT INTO "StorefrontSessionRepair"
      ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
    SELECT
      gen_random_uuid(),
      e."storeId",
      e."sessionId",
      MAX(e."receivedAt"),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "StorefrontEvent" e
    WHERE e."storeId" = ${storeId}::uuid
      AND e."sessionId" IS NOT NULL
      AND ${evidencePredicate}
    GROUP BY e."storeId", e."sessionId"
    ON CONFLICT ("storeId", "browserSessionId")
    DO UPDATE SET
      "id" = EXCLUDED."id",
      "sourceReceivedAt" = GREATEST(
        "StorefrontSessionRepair"."sourceReceivedAt",
        EXCLUDED."sourceReceivedAt"
      ),
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

/**
 * Full-sync persistence optimized for page-sized Shopify payloads.
 * Webhook reconciliation keeps using the single-record methods in ShopifyRepository.
 */
export class ShopifyCatalogRepository {
  async persistProducts(storeId: string, products: ShopifyProduct[]): Promise<void> {
    if (products.length === 0) return;

    await prisma.$transaction(async (tx) => {
      const ids = products.map((product) => product.id);
      const existing = await tx.product.findMany({
        where: { storeId, shopifyProductId: { in: ids } },
        select: { id: true, shopifyProductId: true },
      });
      const existingByExternalId = new Map(
        existing.map((product) => [product.shopifyProductId, product.id]),
      );

      const newProducts = products.filter((product) => !existingByExternalId.has(product.id));
      if (newProducts.length > 0) {
        await tx.product.createMany({
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
        tx.product.update({
          where: { id: existingByExternalId.get(product.id)! },
          data: productData(product),
          select: { id: true },
        }),
      );

      await enqueuePixelResolutionRepairsWith(tx, storeId);
    });
  }

  async persistVariants(storeId: string, variants: ShopifyVariant[]): Promise<boolean> {
    if (variants.length === 0) return true;

    const persisted = await prisma.$transaction(async (tx) => {
      const productExternalIds = [...new Set(variants.map((variant) => variant.product.id))];
      const variantExternalIds = variants.map((variant) => variant.id);

      const [products, existingVariants] = await Promise.all([
        tx.product.findMany({
          where: { storeId, shopifyProductId: { in: productExternalIds }, deletedAt: null },
          select: { id: true, shopifyProductId: true },
        }),
        tx.productVariant.findMany({
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
        await tx.productVariant.createMany({
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
        tx.productVariant.update({
          where: { id: existingVariantMap.get(variant.id)! },
          data: variantData(variant, productMap.get(variant.product.id)!),
          select: { id: true },
        }),
      );

      const persistedVariants = await tx.productVariant.findMany({
        where: { storeId, shopifyVariantId: { in: variantExternalIds } },
        select: { id: true, shopifyVariantId: true },
      });
      if (persistedVariants.length !== variants.length) {
        await enqueuePixelResolutionRepairsWith(tx, storeId);
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

      const existingItems = await tx.inventoryItem.findMany({
        where: { variantId: { in: persistedIds } },
        select: { id: true, variantId: true },
      });
      const itemByVariantId = new Map(existingItems.map((item) => [item.variantId, item.id]));
      const newItems = variants.filter(
        (variant) => !itemByVariantId.has(persistedMap.get(variant.id)!),
      );

      if (newItems.length > 0) {
        await tx.inventoryItem.createMany({
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
        return tx.inventoryItem.update({
          where: { id: itemByVariantId.get(variantId)! },
          data: inventoryItemData(variant),
          select: { id: true },
        });
      });

      const inventoryItemCount = await tx.inventoryItem.count({
        where: { storeId, variantId: { in: persistedIds }, deletedAt: null },
      });

      await enqueuePixelResolutionRepairsWith(tx, storeId);
      return inventoryItemCount === persistedIds.length;
    });

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

    for (const variant of withCost) {
      const variantId = variantMap.get(variant.id);
      const cost = variant.inventoryItem.unitCost;
      if (!variantId || !cost) continue;

      const current = currentByVariant.get(variantId);
      if (current && current.amount.toString() === cost.amount && current.currency === cost.currencyCode) {
        continue;
      }

      const effectiveFrom = new Date();
      await prisma.$transaction(async (tx) => {
        if (current) {
          await tx.variantCost.update({
            where: { id: current.id },
            data: { effectiveUntil: effectiveFrom },
          });
        }
        await tx.variantCost.create({
          data: {
            variantId,
            amount: cost.amount,
            currency: cost.currencyCode,
            source: 'SHOPIFY',
            effectiveFrom,
          },
        });
      });
    }
  }

  async persistCollections(storeId: string, collections: ShopifyCollection[]): Promise<void> {
    if (collections.length === 0) return;

    await prisma.$transaction(async (tx) => {
      await runBatched(collections, (collection) =>
        tx.collection.upsert({
          where: {
            storeId_shopifyCollectionId: {
              storeId,
              shopifyCollectionId: collection.id,
            },
          },
          create: {
            storeId,
            shopifyCollectionId: collection.id,
            ...collectionData(collection),
          },
          update: collectionData(collection),
          select: { id: true },
        }),
      );
      await enqueuePixelResolutionRepairsWith(tx, storeId);
    });
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
      await enqueuePixelResolutionRepairsWith(tx, storeId);
      return true;
    });
  }

  async markMissingCollectionsDeleted(storeId: string, activeIds: string[]): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const result = await tx.collection.updateMany({
        where: {
          storeId,
          deletedAt: null,
          ...(activeIds.length > 0 ? { shopifyCollectionId: { notIn: activeIds } } : {}),
        },
        data: { deletedAt: new Date() },
      });
      if (result.count > 0) await enqueuePixelResolutionRepairsWith(tx, storeId);
      return result.count;
    });
  }

  enqueuePixelResolutionRepairs(storeId: string, productExternalId?: string) {
    return enqueuePixelResolutionRepairsWith(prisma, storeId, productExternalId);
  }
}
