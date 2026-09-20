import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { ShopifyCollection, ShopifyProduct, ShopifyVariant } from '../shopify.schema.js';

export type ShopifyBulkSqlClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

function optionalIso(value: string | null | undefined): string | null {
  return value ?? null;
}

function jsonPayload(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Full-sync persistence is page-oriented. Keep those pages set-based so a 100-row Shopify page
 * costs one database write instead of one UPDATE round trip per existing entity.
 *
 * Single-entity webhook reconciliation deliberately remains on the ordinary Prisma upsert path.
 */
export async function bulkUpsertProducts(
  db: ShopifyBulkSqlClient,
  storeId: string,
  products: ShopifyProduct[],
): Promise<void> {
  if (products.length === 0) return;

  const rows = products.map((product) => ({
    id: randomUUID(),
    storeId,
    shopifyProductId: product.id,
    title: product.title,
    handle: product.handle ?? null,
    productType: product.productType ?? null,
    vendor: product.vendor ?? null,
    tags: product.tags,
    status: product.status,
    totalInventory: product.totalInventory ?? null,
    tracksInventory: product.tracksInventory,
    publishedAt: optionalIso(product.publishedAt),
    shopifyCreatedAt: optionalIso(product.createdAt),
    shopifyUpdatedAt: optionalIso(product.updatedAt),
    rawJson: product,
  }));

  await db.$executeRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${jsonPayload(rows)}::jsonb) AS row(
        id uuid,
        "storeId" uuid,
        "shopifyProductId" text,
        title text,
        handle text,
        "productType" text,
        vendor text,
        tags jsonb,
        status text,
        "totalInventory" integer,
        "tracksInventory" boolean,
        "publishedAt" timestamp,
        "shopifyCreatedAt" timestamp,
        "shopifyUpdatedAt" timestamp,
        "rawJson" jsonb
      )
    )
    INSERT INTO "Product" (
      "id",
      "storeId",
      "shopifyProductId",
      "title",
      "handle",
      "productType",
      "vendor",
      "tags",
      "status",
      "totalInventory",
      "tracksInventory",
      "publishedAt",
      "shopifyCreatedAt",
      "shopifyUpdatedAt",
      "deletedAt",
      "rawJson",
      "createdAt",
      "updatedAt"
    )
    SELECT
      input.id,
      input."storeId",
      input."shopifyProductId",
      input.title,
      input.handle,
      input."productType",
      input.vendor,
      ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(input.tags, '[]'::jsonb))
      ),
      input.status,
      input."totalInventory",
      input."tracksInventory",
      input."publishedAt",
      input."shopifyCreatedAt",
      input."shopifyUpdatedAt",
      NULL,
      input."rawJson",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM input
    ON CONFLICT ("storeId", "shopifyProductId") DO UPDATE SET
      "title" = EXCLUDED."title",
      "handle" = EXCLUDED."handle",
      "productType" = EXCLUDED."productType",
      "vendor" = EXCLUDED."vendor",
      "tags" = EXCLUDED."tags",
      "status" = EXCLUDED."status",
      "totalInventory" = EXCLUDED."totalInventory",
      "tracksInventory" = EXCLUDED."tracksInventory",
      "publishedAt" = EXCLUDED."publishedAt",
      "shopifyCreatedAt" = EXCLUDED."shopifyCreatedAt",
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "deletedAt" = NULL,
      "rawJson" = EXCLUDED."rawJson",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

export async function bulkUpsertVariants(
  db: ShopifyBulkSqlClient,
  storeId: string,
  variants: ShopifyVariant[],
  productIdsByExternalId: ReadonlyMap<string, string>,
): Promise<void> {
  if (variants.length === 0) return;

  const rows = variants.map((variant) => ({
    id: randomUUID(),
    storeId,
    productId: productIdsByExternalId.get(variant.product.id)!,
    shopifyVariantId: variant.id,
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
    shopifyCreatedAt: optionalIso(variant.createdAt),
    shopifyUpdatedAt: optionalIso(variant.updatedAt),
    rawJson: variant,
  }));

  await db.$executeRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${jsonPayload(rows)}::jsonb) AS row(
        id uuid,
        "storeId" uuid,
        "productId" uuid,
        "shopifyVariantId" text,
        title text,
        "displayName" text,
        sku text,
        barcode text,
        price numeric(20, 6),
        "compareAtPrice" numeric(20, 6),
        position integer,
        "availableForSale" boolean,
        "inventoryQuantity" integer,
        "inventoryPolicy" text,
        "shopifyCreatedAt" timestamp,
        "shopifyUpdatedAt" timestamp,
        "rawJson" jsonb
      )
    )
    INSERT INTO "ProductVariant" (
      "id",
      "storeId",
      "productId",
      "shopifyVariantId",
      "title",
      "displayName",
      "sku",
      "barcode",
      "price",
      "compareAtPrice",
      "position",
      "availableForSale",
      "inventoryQuantity",
      "inventoryPolicy",
      "shopifyCreatedAt",
      "shopifyUpdatedAt",
      "deletedAt",
      "rawJson",
      "createdAt",
      "updatedAt"
    )
    SELECT
      input.id,
      input."storeId",
      input."productId",
      input."shopifyVariantId",
      input.title,
      input."displayName",
      input.sku,
      input.barcode,
      input.price,
      input."compareAtPrice",
      input.position,
      input."availableForSale",
      input."inventoryQuantity",
      input."inventoryPolicy",
      input."shopifyCreatedAt",
      input."shopifyUpdatedAt",
      NULL,
      input."rawJson",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM input
    ON CONFLICT ("storeId", "shopifyVariantId") DO UPDATE SET
      "productId" = EXCLUDED."productId",
      "title" = EXCLUDED."title",
      "displayName" = EXCLUDED."displayName",
      "sku" = EXCLUDED."sku",
      "barcode" = EXCLUDED."barcode",
      "price" = EXCLUDED."price",
      "compareAtPrice" = EXCLUDED."compareAtPrice",
      "position" = EXCLUDED."position",
      "availableForSale" = EXCLUDED."availableForSale",
      "inventoryQuantity" = EXCLUDED."inventoryQuantity",
      "inventoryPolicy" = EXCLUDED."inventoryPolicy",
      "shopifyCreatedAt" = EXCLUDED."shopifyCreatedAt",
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "deletedAt" = NULL,
      "rawJson" = EXCLUDED."rawJson",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

export async function bulkUpsertInventoryItems(
  db: ShopifyBulkSqlClient,
  storeId: string,
  variants: ShopifyVariant[],
  variantIdsByExternalId: ReadonlyMap<string, string>,
): Promise<void> {
  if (variants.length === 0) return;

  const rows = variants.map((variant) => {
    const item = variant.inventoryItem;
    return {
      id: randomUUID(),
      storeId,
      variantId: variantIdsByExternalId.get(variant.id)!,
      shopifyInventoryItemId: item.id,
      sku: item.sku ?? variant.sku ?? null,
      tracked: item.tracked,
      requiresShipping: item.requiresShipping,
      shopifyCreatedAt: optionalIso(item.createdAt),
      shopifyUpdatedAt: optionalIso(item.updatedAt),
      rawJson: item,
    };
  });

  await db.$executeRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${jsonPayload(rows)}::jsonb) AS row(
        id uuid,
        "storeId" uuid,
        "variantId" uuid,
        "shopifyInventoryItemId" text,
        sku text,
        tracked boolean,
        "requiresShipping" boolean,
        "shopifyCreatedAt" timestamp,
        "shopifyUpdatedAt" timestamp,
        "rawJson" jsonb
      )
    )
    INSERT INTO "InventoryItem" (
      "id",
      "storeId",
      "variantId",
      "shopifyInventoryItemId",
      "sku",
      "tracked",
      "requiresShipping",
      "shopifyCreatedAt",
      "shopifyUpdatedAt",
      "deletedAt",
      "rawJson",
      "createdAt",
      "updatedAt"
    )
    SELECT
      input.id,
      input."storeId",
      input."variantId",
      input."shopifyInventoryItemId",
      input.sku,
      input.tracked,
      input."requiresShipping",
      input."shopifyCreatedAt",
      input."shopifyUpdatedAt",
      NULL,
      input."rawJson",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM input
    ON CONFLICT ("variantId") DO UPDATE SET
      "storeId" = EXCLUDED."storeId",
      "shopifyInventoryItemId" = EXCLUDED."shopifyInventoryItemId",
      "sku" = EXCLUDED."sku",
      "tracked" = EXCLUDED."tracked",
      "requiresShipping" = EXCLUDED."requiresShipping",
      "shopifyCreatedAt" = EXCLUDED."shopifyCreatedAt",
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "deletedAt" = NULL,
      "rawJson" = EXCLUDED."rawJson",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

export async function bulkUpsertCollections(
  db: ShopifyBulkSqlClient,
  storeId: string,
  collections: ShopifyCollection[],
): Promise<void> {
  if (collections.length === 0) return;

  const rows = collections.map((collection) => ({
    id: randomUUID(),
    storeId,
    shopifyCollectionId: collection.id,
    title: collection.title,
    handle: collection.handle ?? null,
    descriptionHtml: collection.descriptionHtml ?? null,
    sortOrder: collection.sortOrder ?? null,
    imageUrl: collection.image?.url ?? null,
    shopifyUpdatedAt: optionalIso(collection.updatedAt),
    rawJson: collection,
  }));

  await db.$executeRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${jsonPayload(rows)}::jsonb) AS row(
        id uuid,
        "storeId" uuid,
        "shopifyCollectionId" text,
        title text,
        handle text,
        "descriptionHtml" text,
        "sortOrder" text,
        "imageUrl" text,
        "shopifyUpdatedAt" timestamp,
        "rawJson" jsonb
      )
    )
    INSERT INTO "Collection" (
      "id",
      "storeId",
      "shopifyCollectionId",
      "title",
      "handle",
      "descriptionHtml",
      "sortOrder",
      "imageUrl",
      "shopifyUpdatedAt",
      "deletedAt",
      "rawJson",
      "createdAt",
      "updatedAt"
    )
    SELECT
      input.id,
      input."storeId",
      input."shopifyCollectionId",
      input.title,
      input.handle,
      input."descriptionHtml",
      input."sortOrder",
      input."imageUrl",
      input."shopifyUpdatedAt",
      NULL,
      input."rawJson",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM input
    ON CONFLICT ("storeId", "shopifyCollectionId") DO UPDATE SET
      "title" = EXCLUDED."title",
      "handle" = EXCLUDED."handle",
      "descriptionHtml" = EXCLUDED."descriptionHtml",
      "sortOrder" = EXCLUDED."sortOrder",
      "imageUrl" = EXCLUDED."imageUrl",
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "deletedAt" = NULL,
      "rawJson" = EXCLUDED."rawJson",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

export interface InventoryLevelBulkRow {
  inventoryItemId: string;
  locationId: string;
  available: number;
  incoming: number;
  committed: number;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  qualityControl: number;
  sourceUpdatedAt: Date | null;
}

export async function bulkUpsertInventoryLevels(
  db: ShopifyBulkSqlClient,
  rows: InventoryLevelBulkRow[],
  reconciledAt: Date,
): Promise<void> {
  if (rows.length === 0) return;

  const payload = rows.map((row) => ({
    id: randomUUID(),
    ...row,
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
    lastReconciledAt: reconciledAt.toISOString(),
  }));

  await db.$executeRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${jsonPayload(payload)}::jsonb) AS row(
        id uuid,
        "inventoryItemId" uuid,
        "locationId" uuid,
        available integer,
        incoming integer,
        committed integer,
        "onHand" integer,
        reserved integer,
        damaged integer,
        "safetyStock" integer,
        "qualityControl" integer,
        "sourceUpdatedAt" timestamp,
        "lastReconciledAt" timestamp
      )
    )
    INSERT INTO "InventoryLevelCurrent" (
      "id",
      "inventoryItemId",
      "locationId",
      "available",
      "incoming",
      "committed",
      "onHand",
      "reserved",
      "damaged",
      "safetyStock",
      "qualityControl",
      "sourceUpdatedAt",
      "lastReconciledAt",
      "createdAt",
      "updatedAt"
    )
    SELECT
      input.id,
      input."inventoryItemId",
      input."locationId",
      input.available,
      input.incoming,
      input.committed,
      input."onHand",
      input.reserved,
      input.damaged,
      input."safetyStock",
      input."qualityControl",
      input."sourceUpdatedAt",
      input."lastReconciledAt",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM input
    ON CONFLICT ("inventoryItemId", "locationId") DO UPDATE SET
      "available" = EXCLUDED."available",
      "incoming" = EXCLUDED."incoming",
      "committed" = EXCLUDED."committed",
      "onHand" = EXCLUDED."onHand",
      "reserved" = EXCLUDED."reserved",
      "damaged" = EXCLUDED."damaged",
      "safetyStock" = EXCLUDED."safetyStock",
      "qualityControl" = EXCLUDED."qualityControl",
      "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
      "lastReconciledAt" = EXCLUDED."lastReconciledAt",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}
