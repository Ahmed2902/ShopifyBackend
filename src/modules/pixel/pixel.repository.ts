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

  stageInstallation(input: {
    id: string;
    storeId: string;
    collectorTokenHash: string;
    collectorTokenPrefix: string;
  }) {
    return prisma.pixelInstallation.upsert({
      where: { storeId: input.storeId },
      create: {
        id: input.id,
        storeId: input.storeId,
        collectorTokenHash: input.collectorTokenHash,
        collectorTokenPrefix: input.collectorTokenPrefix,
        pendingCollectorTokenHash: input.collectorTokenHash,
        pendingCollectorTokenPrefix: input.collectorTokenPrefix,
        shopifyWebPixelId: null,
        status: 'PROVISIONING',
        installedAt: null,
        lastError: null,
      },
      update: {
        pendingCollectorTokenHash: input.collectorTokenHash,
        pendingCollectorTokenPrefix: input.collectorTokenPrefix,
        lastError: null,
      },
      select: {
        id: true,
        storeId: true,
        status: true,
        shopifyWebPixelId: true,
      },
    });
  }

  async finalizeInstallation(input: {
    id: string;
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
        "collectorTokenHash" = COALESCE("pendingCollectorTokenHash", "collectorTokenHash"),
        "collectorTokenPrefix" = COALESCE("pendingCollectorTokenPrefix", "collectorTokenPrefix"),
        "pendingCollectorTokenHash" = NULL,
        "pendingCollectorTokenPrefix" = NULL,
        "shopifyWebPixelId" = ${input.shopifyWebPixelId},
        "status" = 'ACTIVE'::"PixelInstallationStatus",
        "installedAt" = ${input.installedAt},
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.id}::uuid
      RETURNING
        "id", "storeId", "collectorTokenPrefix", "shopifyWebPixelId", "status",
        "installedAt", "lastEventAt", "lastError", "updatedAt"
    `;
    return rows[0] ?? null;
  }

  rollbackStagedInstallation(id: string, hadWorkingInstallation: boolean, lastError: string) {
    if (hadWorkingInstallation) {
      return prisma.pixelInstallation.update({
        where: { id },
        data: {
          pendingCollectorTokenHash: null,
          pendingCollectorTokenPrefix: null,
          lastError,
        },
        select: { id: true, status: true },
      });
    }
    return prisma.pixelInstallation.update({
      where: { id },
      data: {
        pendingCollectorTokenHash: null,
        pendingCollectorTokenPrefix: null,
        status: 'ERROR',
        lastError,
      },
      select: { id: true, status: true },
    });
  }

  recordInstallationError(id: string, lastError: string) {
    return prisma.pixelInstallation.update({
      where: { id },
      data: { lastError },
      select: { id: true, status: true },
    });
  }

  async insertEvents(storeId: string, events: StoreScopedEventInput[]) {
    if (events.length === 0) return 0;

    const result = await prisma.storefrontEvent.createMany({
      data: events.map((event) => ({ ...event, storeId })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async markSessionRepairs(storeId: string, browserSessionIds: string[], sourceReceivedAt: Date) {
    for (const browserSessionId of [...new Set(browserSessionIds)]) {
      const id = randomUUID();
      await prisma.$executeRaw`
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
