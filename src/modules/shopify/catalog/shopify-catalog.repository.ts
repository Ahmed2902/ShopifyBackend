import { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type { ShopifyCollection, ShopifyProduct, ShopifyVariant } from '../shopify.schema.js';
import {
  bulkUpsertCollections,
  bulkUpsertInventoryItems,
  bulkUpsertProducts,
  bulkUpsertVariants,
} from '../shared/shopify-bulk-write.js';

const CATALOG_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

type RepairSqlClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

interface CatalogRepairEvidence {
  productIds?: string[];
  variantIds?: string[];
  collectionIds?: string[];
}

function distinct(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function sqlValues(values: string[]) {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

async function enqueuePixelResolutionRepairsWith(
  db: RepairSqlClient,
  storeId: string,
  evidence?: CatalogRepairEvidence,
) {
  const productIds = distinct(evidence?.productIds);
  const variantIds = distinct(evidence?.variantIds);
  const collectionIds = distinct(evidence?.collectionIds);
  if (evidence && productIds.length === 0 && variantIds.length === 0 && collectionIds.length === 0) {
    return 0;
  }

  // A raw-only or currently-materializing browser session already owns a repair row. Rotate every
  // outstanding generation for this store inside the same source mutation transaction so a worker
  // that resolved against the pre-mutation catalog can never consume its old generation and commit
  // stale identity after this transaction succeeds. Clean materialized sessions are handled by the
  // targeted compact-evidence insert below, avoiding a retained raw-event scan per catalog write.
  await db.$executeRaw`
    UPDATE "StorefrontSessionRepair"
    SET
      "id" = gen_random_uuid(),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "storeId" = ${storeId}::uuid
  `;

  const productConditions: Prisma.Sql[] = [];
  if (productIds.length > 0) {
    productConditions.push(
      Prisma.sql`p."shopifyProductExternalId" IN (${sqlValues(productIds)})`,
      Prisma.sql`p."shopifyVariantExternalId" IN (
        SELECT pv."shopifyVariantId"
        FROM "ProductVariant" pv
        INNER JOIN "Product" product ON product."id" = pv."productId"
        WHERE pv."storeId" = ${storeId}::uuid
          AND product."storeId" = ${storeId}::uuid
          AND product."shopifyProductId" IN (${sqlValues(productIds)})
      )`,
    );
  }
  if (variantIds.length > 0) {
    productConditions.push(
      Prisma.sql`p."shopifyVariantExternalId" IN (${sqlValues(variantIds)})`,
    );
  }
  const productPredicate = evidence
    ? productConditions.length > 0
      ? Prisma.join(productConditions, ' OR ')
      : Prisma.sql`FALSE`
    : Prisma.sql`(
        p."shopifyProductExternalId" IS NOT NULL
        OR p."shopifyVariantExternalId" IS NOT NULL
      )`;
  const collectionPredicate = evidence
    ? collectionIds.length > 0
      ? Prisma.sql`c."shopifyCollectionExternalId" IN (${sqlValues(collectionIds)})`
      : Prisma.sql`FALSE`
    : Prisma.sql`c."shopifyCollectionExternalId" IS NOT NULL`;

  return db.$executeRaw`
    INSERT INTO "StorefrontSessionRepair"
      ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
    SELECT
      gen_random_uuid(),
      affected."storeId",
      affected."browserSessionId",
      MAX(affected."sourceReceivedAt"),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM (
      SELECT s."storeId", s."browserSessionId", s."lastSourceReceivedAt" AS "sourceReceivedAt"
      FROM "StorefrontSession" s
      INNER JOIN "StorefrontSessionProduct" p ON p."sessionId" = s."id"
      WHERE s."storeId" = ${storeId}::uuid
        AND (${productPredicate})
      UNION ALL
      SELECT s."storeId", s."browserSessionId", s."lastSourceReceivedAt" AS "sourceReceivedAt"
      FROM "StorefrontSession" s
      INNER JOIN "StorefrontSessionCollection" c ON c."sessionId" = s."id"
      WHERE s."storeId" = ${storeId}::uuid
        AND (${collectionPredicate})
    ) affected
    GROUP BY affected."storeId", affected."browserSessionId"
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

    const ids = products.map((product) => product.id);
    await prisma.$transaction(async (tx) => {
      await bulkUpsertProducts(tx, storeId, products);
      await enqueuePixelResolutionRepairsWith(tx, storeId, { productIds: ids });
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
        await enqueuePixelResolutionRepairsWith(tx, storeId, { variantIds: variantExternalIds });
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

      await enqueuePixelResolutionRepairsWith(tx, storeId, { variantIds: variantExternalIds });
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
      await enqueuePixelResolutionRepairsWith(tx, storeId, { collectionIds });
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
      await enqueuePixelResolutionRepairsWith(tx, storeId, { collectionIds: [shopifyCollectionId] });
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

      await enqueuePixelResolutionRepairsWith(tx, storeId, {
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
      await enqueuePixelResolutionRepairsWith(tx, storeId, {
        collectionIds: missing.map((collection) => collection.shopifyCollectionId),
      });
      return missing.length;
    }, CATALOG_TRANSACTION_OPTIONS);
  }

  enqueuePixelResolutionRepairs(storeId: string, productExternalId?: string) {
    return enqueuePixelResolutionRepairsWith(
      prisma,
      storeId,
      productExternalId ? { productIds: [productExternalId] } : undefined,
    );
  }
}
