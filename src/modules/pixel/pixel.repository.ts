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
    hadWorkingInstallation: boolean,
    lastError: string,
  ) {
    const status = hadWorkingInstallation ? 'ACTIVE' : 'ERROR';
    const rows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      UPDATE "PixelInstallation"
      SET
        "pendingCollectorTokenHash" = NULL,
        "pendingCollectorTokenPrefix" = NULL,
        "status" = ${status}::"PixelInstallationStatus",
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
        END,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
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
        AND (
          e."sessionId" IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM "StorefrontSessionRepair" r
            WHERE r."storeId" = e."storeId"
              AND r."browserSessionId" = e."sessionId"
          )
        )
      ORDER BY e."retentionExpiresAt" ASC, e."id" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  }

  async deleteEventsByIds(ids: string[]) {
    if (ids.length === 0) return 0;
    const result = await prisma.storefrontEvent.deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }
}
