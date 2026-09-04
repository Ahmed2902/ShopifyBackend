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
        status: true,
      },
    });
  }

  upsertInstallation(input: {
    id: string;
    storeId: string;
    collectorTokenHash: string;
    collectorTokenPrefix: string;
    shopifyWebPixelId: string | null;
    status: 'ACTIVE' | 'ERROR' | 'DISABLED';
    installedAt: Date | null;
    lastError: string | null;
  }) {
    return prisma.pixelInstallation.upsert({
      where: { storeId: input.storeId },
      create: input,
      update: {
        collectorTokenHash: input.collectorTokenHash,
        collectorTokenPrefix: input.collectorTokenPrefix,
        shopifyWebPixelId: input.shopifyWebPixelId,
        status: input.status,
        installedAt: input.installedAt,
        lastError: input.lastError,
      },
      select: {
        id: true,
        storeId: true,
        collectorTokenPrefix: true,
        shopifyWebPixelId: true,
        status: true,
        installedAt: true,
        lastEventAt: true,
        lastError: true,
        updatedAt: true,
      },
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

  touchInstallation(id: string, lastEventAt: Date) {
    return prisma.pixelInstallation.update({
      where: { id },
      data: { lastEventAt, lastError: null },
      select: { id: true },
    });
  }

  async findExpiredEventIds(now: Date, limit: number) {
    const rows = await prisma.storefrontEvent.findMany({
      where: { retentionExpiresAt: { lte: now } },
      orderBy: [{ retentionExpiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async deleteEventsByIds(ids: string[]) {
    if (ids.length === 0) return 0;
    const result = await prisma.storefrontEvent.deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }
}
