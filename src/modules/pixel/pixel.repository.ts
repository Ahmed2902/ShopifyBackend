import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

type StoreScopedEventInput = Omit<Prisma.StorefrontEventCreateManyInput, 'storeId'>;

export class PixelRepository {
  findInstallationByStoreId(storeId: string) {
    return prisma.pixelInstallation.findUnique({
      where: { storeId },
      select: {
        id: true,
        storeId: true,
        collectorTokenPrefix: true,
        shopifyWebPixelId: true,
        status: true,
        installedAt: true,
        lastEventAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  findInstallationForProvisioning(storeId: string) {
    return prisma.pixelInstallation.findUnique({
      where: { storeId },
      select: {
        id: true,
        storeId: true,
        shopifyWebPixelId: true,
        status: true,
        installedAt: true,
        lastError: true,
        pendingCollectorTokenHash: true,
        updatedAt: true,
      },
    });
  }

  findInstallationForIngress(id: string) {
    return prisma.pixelInstallation.findUnique({
      where: { id },
      select: {
        id: true,
        storeId: true,
        collectorTokenHash: true,
        pendingCollectorTokenHash: true,
        status: true,
      },
    });
  }

  async stageInstallation(input: {
    id: string;
    storeId: string;
    collectorTokenHash: string;
    collectorTokenPrefix: string;
    status: 'ACTIVE' | 'PROVISIONING';
  }) {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        storeId: string;
        status: 'ACTIVE' | 'PROVISIONING' | 'ERROR' | 'DISABLED';
        shopifyWebPixelId: string | null;
      }>
    >`
      INSERT INTO "PixelInstallation" (
        "id", "storeId", "collectorTokenHash", "collectorTokenPrefix",
        "pendingCollectorTokenHash", "pendingCollectorTokenPrefix",
        "shopifyWebPixelId", "status", "installedAt", "lastError",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${input.id}::uuid,
        ${input.storeId}::uuid,
        ${input.collectorTokenHash},
        ${input.collectorTokenPrefix},
        ${input.collectorTokenHash},
        ${input.collectorTokenPrefix},
        NULL,
        ${input.status}::"PixelInstallationStatus",
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("storeId")
      DO UPDATE SET
        "collectorTokenHash" = CASE
          WHEN "PixelInstallation"."lastError" IS NOT NULL
            AND "PixelInstallation"."pendingCollectorTokenHash" IS NOT NULL
          THEN "PixelInstallation"."pendingCollectorTokenHash"
          ELSE "PixelInstallation"."collectorTokenHash"
        END,
        "collectorTokenPrefix" = CASE
          WHEN "PixelInstallation"."lastError" IS NOT NULL
            AND "PixelInstallation"."pendingCollectorTokenPrefix" IS NOT NULL
          THEN "PixelInstallation"."pendingCollectorTokenPrefix"
          ELSE "PixelInstallation"."collectorTokenPrefix"
        END,
        "pendingCollectorTokenHash" = EXCLUDED."pendingCollectorTokenHash",
        "pendingCollectorTokenPrefix" = EXCLUDED."pendingCollectorTokenPrefix",
        "status" = EXCLUDED."status",
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "PixelInstallation"."pendingCollectorTokenHash" IS NULL
         OR "PixelInstallation"."lastError" IS NOT NULL
      RETURNING "id", "storeId", "status", "shopifyWebPixelId"
    `;
    return rows[0] ?? null;
  }

  async finalizeInstallation(input: {
    id: string;
    expectedPendingTokenHash: string;
    shopifyWebPixelId: string;
    installedAt: Date;
  }) {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        storeId: string;
        collectorTokenPrefix: string;
        shopifyWebPixelId: string | null;
        status: 'ACTIVE' | 'PROVISIONING' | 'ERROR' | 'DISABLED';
        installedAt: Date | null;
        lastEventAt: Date | null;
        lastError: string | null;
        updatedAt: Date;
      }>
    >`
      UPDATE "PixelInstallation"
      SET
        "collectorTokenHash" = "pendingCollectorTokenHash",
        "collectorTokenPrefix" = COALESCE("pendingCollectorTokenPrefix", "collectorTokenPrefix"),
        "pendingCollectorTokenHash" = NULL,
        "pendingCollectorTokenPrefix" = NULL,
        "shopifyWebPixelId" = ${input.shopifyWebPixelId},
        "status" = 'ACTIVE'::"PixelInstallationStatus",
        "installedAt" = ${input.installedAt},
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.id}::uuid
        AND "pendingCollectorTokenHash" = ${input.expectedPendingTokenHash}
      RETURNING
        "id", "storeId", "collectorTokenPrefix", "shopifyWebPixelId", "status",
        "installedAt", "lastEventAt", "lastError", "updatedAt"
    `;
    return rows[0] ?? null;
  }

  async rollbackStagedInstallation(
    id: string,
    expectedPendingTokenHash: string,
    rollbackStatus: 'ACTIVE' | 'PROVISIONING' | 'ERROR',
    lastError: string,
  ) {
    const rows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      UPDATE "PixelInstallation"
      SET
        "pendingCollectorTokenHash" = NULL,
        "pendingCollectorTokenPrefix" = NULL,
        "status" = ${rollbackStatus}::"PixelInstallationStatus",
        "lastError" = ${lastError},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid
        AND "pendingCollectorTokenHash" = ${expectedPendingTokenHash}
      RETURNING "id", "status"
    `;
    return rows[0] ?? null;
  }

  async recordInstallationError(id: string, expectedPendingTokenHash: string, lastError: string) {
    const rows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      UPDATE "PixelInstallation"
      SET
        "lastError" = ${lastError},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid
        AND "pendingCollectorTokenHash" = ${expectedPendingTokenHash}
      RETURNING "id", "status"
    `;
    return rows[0] ?? null;
  }

  async insertEvents(storeId: string, events: StoreScopedEventInput[], sourceReceivedAt: Date) {
    if (events.length === 0) return 0;

    return prisma.$transaction(async (tx) => {
      const result = await tx.storefrontEvent.createMany({
        data: events.map((event) => ({ ...event, storeId })),
        skipDuplicates: true,
      });

      const sessionIds = [
        ...new Set(
          events
            .map((event) => event.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        ),
      ];
      for (const browserSessionId of sessionIds) {
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "StorefrontSessionRepair"
            ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
          VALUES
            (${id}::uuid, ${storeId}::uuid, ${browserSessionId}, ${sourceReceivedAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT ("storeId", "browserSessionId")
          DO UPDATE SET
            "id" = EXCLUDED."id",
            "sourceReceivedAt" = GREATEST("StorefrontSessionRepair"."sourceReceivedAt", EXCLUDED."sourceReceivedAt"),
            "updatedAt" = CURRENT_TIMESTAMP
        `;
      }

      return result.count;
    });
  }

  async touchInstallation(id: string, lastEventAt: Date) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "PixelInstallation"
      SET
        "lastEventAt" = CASE
          WHEN "lastEventAt" IS NULL THEN ${lastEventAt}
          ELSE GREATEST("lastEventAt", ${lastEventAt})
        END
      WHERE "id" = ${id}::uuid
      RETURNING "id"
    `;
    return rows[0] ?? null;
  }

  async findExpiredEventIds(now: Date, limit: number) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT e."id"
      FROM "StorefrontEvent" e
      WHERE e."retentionExpiresAt" <= ${now}
      ORDER BY e."retentionExpiresAt" ASC, e."id" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  }

  async deleteEventsByIds(ids: string[]) {
    if (ids.length === 0) return 0;

    return prisma.$transaction(async (tx) => {
      const selected = await tx.storefrontEvent.findMany({
        where: { id: { in: ids } },
        select: { id: true, storeId: true, sessionId: true, receivedAt: true },
      });
      if (selected.length === 0) return 0;

      const result = await tx.storefrontEvent.deleteMany({
        where: { id: { in: selected.map((row) => row.id) } },
      });

      const affectedSessions = new Map<
        string,
        { storeId: string; browserSessionId: string; latestDeletedReceivedAt: Date }
      >();
      for (const row of selected) {
        if (!row.sessionId) continue;
        const key = `${row.storeId}:${row.sessionId}`;
        const existing = affectedSessions.get(key);
        affectedSessions.set(key, {
          storeId: row.storeId,
          browserSessionId: row.sessionId,
          latestDeletedReceivedAt:
            existing && existing.latestDeletedReceivedAt > row.receivedAt
              ? existing.latestDeletedReceivedAt
              : row.receivedAt,
        });
      }

      // Every source deletion rotates the repair generation. When the final source disappears,
      // atomically turn the retained session into a zero-evidence dirty tombstone first. The
      // tombstone preserves only cohort/visitor identity needed to remove its prior behavior and
      // downstream attribution contributions. It cannot be retention-deleted until the repair
      // marker is consumed and both rollups acknowledge the new dirty generation.
      for (const { storeId, browserSessionId, latestDeletedReceivedAt } of affectedSessions.values()) {
        const remaining = await tx.storefrontEvent.findFirst({
          where: { storeId, sessionId: browserSessionId },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          select: { receivedAt: true },
        });
        const sourceReceivedAt =
          remaining && remaining.receivedAt > latestDeletedReceivedAt
            ? remaining.receivedAt
            : latestDeletedReceivedAt;

        if (!remaining) {
          const invalidatedAt = new Date();
          const session = await tx.storefrontSession.findUnique({
            where: { storeId_browserSessionId: { storeId, browserSessionId } },
            select: { id: true },
          });
          if (session) {
            await tx.storefrontSession.update({
              where: { id: session.id },
              data: {
                eventCount: 0,
                pageViewCount: 0,
                productViewCount: 0,
                collectionViewCount: 0,
                searchCount: 0,
                addToCartCount: 0,
                removeFromCartCount: 0,
                checkoutProgressCount: 0,
                checkoutStartedAt: null,
                checkoutCompletedAt: null,
                shopifyCheckoutToken: null,
                shopifyOrderExternalId: null,
                orderId: null,
                orderLinkStatus: 'NONE',
                orderLinkAttemptCount: 0,
                orderLinkNextAttemptAt: null,
                landingPageUrl: null,
                initialReferrerUrl: null,
                dataQualityFlags: [],
                retentionExpiresAt: invalidatedAt,
                materializedAt: invalidatedAt,
                rollupDirtyAt: invalidatedAt,
              },
            });
            await tx.storefrontSessionTouch.deleteMany({ where: { sessionId: session.id } });
            await tx.storefrontSessionProduct.deleteMany({ where: { sessionId: session.id } });
            await tx.storefrontSessionCollection.deleteMany({ where: { sessionId: session.id } });
          }
        }

        const repairId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "StorefrontSessionRepair"
            ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
          VALUES
            (${repairId}::uuid, ${storeId}::uuid, ${browserSessionId}, ${sourceReceivedAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT ("storeId", "browserSessionId")
          DO UPDATE SET
            "id" = EXCLUDED."id",
            "sourceReceivedAt" = GREATEST("StorefrontSessionRepair"."sourceReceivedAt", EXCLUDED."sourceReceivedAt"),
            "updatedAt" = CURRENT_TIMESTAMP
        `;
      }

      return result.count;
    });
  }
}
