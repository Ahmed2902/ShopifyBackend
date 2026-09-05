import { prisma } from '../../../lib/prisma.js';

export class PixelRollupStateRepair {
  async repairBehavior(limit = 10) {
    const rows = await prisma.$queryRaw<Array<{ storeId: string }>>`
      WITH candidates AS (
        SELECT
          r."storeId",
          MAX(GREATEST(s."rollupDirtyAt", COALESCE(o."updatedAt", s."rollupDirtyAt"))) AS watermark
        FROM "StorefrontBehaviorRollupState" r
        INNER JOIN "StorefrontSession" s ON s."storeId" = r."storeId"
        LEFT JOIN "Order" o ON o."id" = s."orderId"
        WHERE r."lastError" IS NOT NULL
        GROUP BY r."storeId"
        HAVING BOOL_AND(
          s."behaviorRolledUpAt" IS NOT NULL
          AND s."behaviorRolledUpAt" >= s."rollupDirtyAt"
          AND s."behaviorRolledStartedAt" = s."startedAt"
          AND (o."id" IS NULL OR o."updatedAt" <= s."behaviorRolledUpAt")
        )
        ORDER BY r."storeId"
        LIMIT ${limit}
      )
      UPDATE "StorefrontBehaviorRollupState" r
      SET
        "rolledThroughMaterializedAt" = GREATEST(
          COALESCE(r."rolledThroughMaterializedAt", candidates.watermark),
          candidates.watermark
        ),
        "lastRolledUpAt" = CURRENT_TIMESTAMP,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE r."storeId" = candidates."storeId"
        AND NOT EXISTS (
          SELECT 1
          FROM "StorefrontSession" s
          LEFT JOIN "Order" o ON o."id" = s."orderId"
          WHERE s."storeId" = r."storeId"
            AND (
              s."behaviorRolledUpAt" IS NULL
              OR s."behaviorRolledUpAt" < s."rollupDirtyAt"
              OR s."behaviorRolledStartedAt" IS DISTINCT FROM s."startedAt"
              OR (o."id" IS NOT NULL AND o."updatedAt" > s."behaviorRolledUpAt")
            )
        )
      RETURNING r."storeId"
    `;
    return rows.length;
  }

  async repairAttribution(limit = 10) {
    const rows = await prisma.$queryRaw<Array<{ storeId: string }>>`
      WITH candidates AS (
        SELECT
          r."storeId",
          MAX(GREATEST(s."rollupDirtyAt", COALESCE(o."updatedAt", s."rollupDirtyAt"))) AS watermark
        FROM "StorefrontAttributionRollupState" r
        INNER JOIN "StorefrontSession" s ON s."storeId" = r."storeId"
        LEFT JOIN "Order" o ON o."id" = s."orderId"
        WHERE r."lastError" IS NOT NULL
        GROUP BY r."storeId"
        HAVING BOOL_AND(
          s."attributionRolledUpAt" IS NOT NULL
          AND s."attributionRolledUpAt" >= s."rollupDirtyAt"
          AND s."attributionRolledStartedAt" = s."startedAt"
          AND (o."id" IS NULL OR o."updatedAt" <= s."attributionRolledUpAt")
        )
        ORDER BY r."storeId"
        LIMIT ${limit}
      )
      UPDATE "StorefrontAttributionRollupState" r
      SET
        "rolledThroughSessionUpdatedAt" = GREATEST(
          COALESCE(r."rolledThroughSessionUpdatedAt", candidates.watermark),
          candidates.watermark
        ),
        "lastRolledUpAt" = CURRENT_TIMESTAMP,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE r."storeId" = candidates."storeId"
        AND NOT EXISTS (
          SELECT 1
          FROM "StorefrontSession" s
          LEFT JOIN "Order" o ON o."id" = s."orderId"
          WHERE s."storeId" = r."storeId"
            AND (
              s."attributionRolledUpAt" IS NULL
              OR s."attributionRolledUpAt" < s."rollupDirtyAt"
              OR s."attributionRolledStartedAt" IS DISTINCT FROM s."startedAt"
              OR (o."id" IS NOT NULL AND o."updatedAt" > s."attributionRolledUpAt")
            )
        )
      RETURNING r."storeId"
    `;
    return rows.length;
  }
}

export const pixelRollupStateRepair = new PixelRollupStateRepair();
