import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

type RepairSqlClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export interface MetaHierarchyRepairEvidence {
  campaignIds?: string[];
  adSetIds?: string[];
  adIds?: string[];
}

export interface CommerceEntityRepairEvidence {
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

async function rotateOutstandingRepairGenerations(db: RepairSqlClient, storeId: string) {
  // The repair row id is the generation/fencing token consumed by materialization. Prisma
  // updateMany applies one data object to every row, so it cannot assign a distinct UUID to every
  // repair marker. Keep this tiny SQL primitive centralized here rather than leaking it into source
  // repositories that merely mutate provider/commerce identity.
  await db.$executeRaw`
    UPDATE "StorefrontSessionRepair"
    SET
      "id" = gen_random_uuid(),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "storeId" = ${storeId}::uuid
  `;
}

/**
 * Meta hierarchy rows are provider identity evidence used by the retained Pixel read model.
 *
 * Two populations must be protected whenever resolver truth changes:
 * 1. already-materialized sessions whose compact touch evidence references the changed identity;
 * 2. raw-only / currently-materializing sessions that still have an outstanding repair marker.
 *
 * Rotating existing repair generations first closes the race where a first materializer reads old
 * provider truth, the provider mutation commits, and the materializer otherwise consumes the same
 * marker while writing stale resolution. The targeted compact-evidence insert then handles clean
 * materialized sessions without rescanning retained raw history.
 */
export async function enqueueMetaHierarchyPixelRepairs(
  storeId: string,
  db: RepairSqlClient = prisma,
  evidence?: MetaHierarchyRepairEvidence,
) {
  const campaignIds = distinct(evidence?.campaignIds);
  const adSetIds = distinct(evidence?.adSetIds);
  const adIds = distinct(evidence?.adIds);

  if (evidence && campaignIds.length === 0 && adSetIds.length === 0 && adIds.length === 0) {
    return 0;
  }

  await rotateOutstandingRepairGenerations(db, storeId);

  const predicates: Prisma.Sql[] = [];
  if (campaignIds.length > 0) {
    predicates.push(Prisma.sql`(
      t."metaCampaignExternalId" IN (${sqlValues(campaignIds)})
      OR t."metaCampaignId" IN (
        SELECT c."id"
        FROM "MetaCampaign" c
        INNER JOIN "MetaAdAccount" a ON a."id" = c."adAccountId"
        WHERE a."storeId" = ${storeId}::uuid
          AND c."metaCampaignId" IN (${sqlValues(campaignIds)})
      )
    )`);
  }
  if (adSetIds.length > 0) {
    predicates.push(Prisma.sql`(
      t."metaAdSetExternalId" IN (${sqlValues(adSetIds)})
      OR t."metaAdSetId" IN (
        SELECT a_set."id"
        FROM "MetaAdSet" a_set
        INNER JOIN "MetaAdAccount" a ON a."id" = a_set."adAccountId"
        WHERE a."storeId" = ${storeId}::uuid
          AND a_set."metaAdSetId" IN (${sqlValues(adSetIds)})
      )
    )`);
  }
  if (adIds.length > 0) {
    predicates.push(Prisma.sql`(
      t."metaAdExternalId" IN (${sqlValues(adIds)})
      OR t."metaAdId" IN (
        SELECT ad."id"
        FROM "MetaAd" ad
        INNER JOIN "MetaAdAccount" a ON a."id" = ad."adAccountId"
        WHERE a."storeId" = ${storeId}::uuid
          AND ad."metaAdId" IN (${sqlValues(adIds)})
      )
    )`);
  }

  const evidencePredicate = evidence
    ? Prisma.join(predicates, ' OR ')
    : Prisma.sql`(
        t."metaCampaignExternalId" IS NOT NULL
        OR t."metaAdSetExternalId" IS NOT NULL
        OR t."metaAdExternalId" IS NOT NULL
        OR t."metaCampaignId" IS NOT NULL
        OR t."metaAdSetId" IS NOT NULL
        OR t."metaAdId" IS NOT NULL
      )`;

  return db.$executeRaw`
    INSERT INTO "StorefrontSessionRepair"
      ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
    SELECT
      gen_random_uuid(),
      affected."storeId",
      affected."browserSessionId",
      affected."sourceReceivedAt",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM (
      SELECT
        s."storeId",
        s."browserSessionId",
        MAX(s."lastSourceReceivedAt") AS "sourceReceivedAt"
      FROM "StorefrontSession" s
      INNER JOIN "StorefrontSessionTouch" t ON t."sessionId" = s."id"
      WHERE s."storeId" = ${storeId}::uuid
        AND (${evidencePredicate})
      GROUP BY s."storeId", s."browserSessionId"
    ) affected
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
 * Commerce identity mutations use the same repair-generation contract as Meta hierarchy changes.
 * Keep the set-based repair selection/upsert in this Pixel boundary: Prisma can express the source
 * reads, but not the required heterogeneous upsert plus per-row generation rotation without
 * turning one catalog page mutation into many round trips.
 */
export async function enqueueCommerceEntityPixelRepairs(
  storeId: string,
  db: RepairSqlClient = prisma,
  evidence?: CommerceEntityRepairEvidence,
) {
  const productIds = distinct(evidence?.productIds);
  const variantIds = distinct(evidence?.variantIds);
  const collectionIds = distinct(evidence?.collectionIds);

  if (evidence && productIds.length === 0 && variantIds.length === 0 && collectionIds.length === 0) {
    return 0;
  }

  await rotateOutstandingRepairGenerations(db, storeId);

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
