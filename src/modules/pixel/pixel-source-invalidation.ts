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
 * Raw-only sessions already have a durable repair marker from ingestion, so source changes only
 * need to rotate generations for materialized sessions whose compact touch evidence is affected.
 * Passing no evidence intentionally invalidates every retained materialized Meta touch for a store.
 */
export function enqueueMetaHierarchyPixelRepairs(
  storeId: string,
  db: RepairSqlClient = prisma,
  evidence?: MetaHierarchyRepairEvidence,
) {
  const campaignIds = distinct(evidence?.campaignIds);
  const adSetIds = distinct(evidence?.adSetIds);
  const adIds = distinct(evidence?.adIds);

  if (evidence && campaignIds.length === 0 && adSetIds.length === 0 && adIds.length === 0) {
    return Promise.resolve(0);
  }

  const evidencePredicate = evidence
    ? Prisma.join(
        [
          ...(campaignIds.length > 0
            ? [Prisma.sql`t."metaCampaignExternalId" IN (${sqlValues(campaignIds)})`]
            : []),
          ...(adSetIds.length > 0
            ? [Prisma.sql`t."metaAdSetExternalId" IN (${sqlValues(adSetIds)})`]
            : []),
          ...(adIds.length > 0
            ? [Prisma.sql`t."metaAdExternalId" IN (${sqlValues(adIds)})`]
            : []),
        ],
        ' OR ',
      )
    : Prisma.sql`(
        t."metaCampaignExternalId" IS NOT NULL
        OR t."metaAdSetExternalId" IS NOT NULL
        OR t."metaAdExternalId" IS NOT NULL
      )`;

  return db.$executeRaw`
    INSERT INTO "StorefrontSessionRepair"
      ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
    SELECT DISTINCT
      gen_random_uuid(),
      s."storeId",
      s."browserSessionId",
      s."lastSourceReceivedAt",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "StorefrontSession" s
    INNER JOIN "StorefrontSessionTouch" t ON t."sessionId" = s."id"
    WHERE s."storeId" = ${storeId}::uuid
      AND (${evidencePredicate})
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
