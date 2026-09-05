import { prisma } from '../../lib/prisma.js';

/**
 * Meta hierarchy rows are provider identity evidence used by the retained Pixel read model.
 * Any successfully committed hierarchy snapshot can change EXACT/PARTIAL/UNRESOLVED/CONFLICT
 * resolution, so rotate repair generations immediately at that source-domain commit boundary.
 */
export function enqueueMetaHierarchyPixelRepairs(storeId: string) {
  return prisma.$executeRaw`
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
      AND (
        e."metaCampaignExternalId" IS NOT NULL
        OR e."metaAdSetExternalId" IS NOT NULL
        OR e."metaAdExternalId" IS NOT NULL
      )
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
