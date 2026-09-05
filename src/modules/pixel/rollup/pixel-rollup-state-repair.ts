import { prisma } from '../../../lib/prisma.js';

export class PixelRollupStateRepair {
  async repairBehavior(limit = 10) {
    const rows = await prisma.$queryRaw<Array<{ storeId: string }>>`
      WITH candidates AS (
        SELECT
          r."storeId",
          COALESCE(
            MAX(GREATEST(s."rollupDirtyAt", COALESCE(o."updatedAt", s."rollupDirtyAt")))
              FILTER (WHERE s."id" IS NOT NULL),
            r."rolledThroughMaterializedAt",
            CURRENT_TIMESTAMP
          ) AS watermark
        FROM "StorefrontBehaviorRollupState" r
        LEFT JOIN "StorefrontSession" s ON s."storeId" = r."storeId"
        LEFT JOIN "Order" o ON o."id" = s."orderId"
        WHERE r."lastError" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "StorefrontSession" dirty
            LEFT JOIN "Order" dirty_order ON dirty_order."id" = dirty."orderId"
            WHERE dirty."storeId" = r."storeId"
              AND (
                dirty."behaviorRolledUpAt" IS NULL
                OR dirty."behaviorRolledUpAt" < dirty."rollupDirtyAt"
                OR dirty."behaviorRolledStartedAt" IS DISTINCT FROM dirty."startedAt"
                OR (
                  dirty_order."id" IS NOT NULL
                  AND dirty_order."updatedAt" > dirty."behaviorRolledUpAt"
                )
              )
          )
        GROUP BY r."storeId", r."rolledThroughMaterializedAt"
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
          COALESCE(
            MAX(GREATEST(s."rollupDirtyAt", COALESCE(o."updatedAt", s."rollupDirtyAt")))
              FILTER (WHERE s."id" IS NOT NULL),
            r."rolledThroughSessionUpdatedAt",
            CURRENT_TIMESTAMP
          ) AS watermark
        FROM "StorefrontAttributionRollupState" r
        LEFT JOIN "StorefrontSession" s ON s."storeId" = r."storeId"
        LEFT JOIN "Order" o ON o."id" = s."orderId"
        WHERE r."lastError" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "StorefrontSession" dirty
            LEFT JOIN "Order" dirty_order ON dirty_order."id" = dirty."orderId"
            WHERE dirty."storeId" = r."storeId"
              AND (
                dirty."attributionRolledUpAt" IS NULL
                OR dirty."attributionRolledUpAt" < dirty."rollupDirtyAt"
                OR dirty."attributionRolledStartedAt" IS DISTINCT FROM dirty."startedAt"
                OR (
                  dirty_order."id" IS NOT NULL
                  AND dirty_order."updatedAt" > dirty."attributionRolledUpAt"
                )
              )
          )
        GROUP BY r."storeId", r."rolledThroughSessionUpdatedAt"
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
