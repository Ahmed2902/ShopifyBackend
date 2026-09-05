import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

type RepairSqlClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export interface MetaHierarchyRepairEvidence {
  campaignIds?: string[];
  adSetIds?: string[];
  adIds?: string[];
}

function distinct(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function sqlValues(values: string[]) {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
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

  await db.$executeRaw`
    UPDATE "StorefrontSessionRepair"
    SET
      "id" = gen_random_uuid(),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "storeId" = ${storeId}::uuid
  `;

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
