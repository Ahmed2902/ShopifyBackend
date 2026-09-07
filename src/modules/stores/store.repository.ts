import { prisma } from '../../lib/prisma.js';

export class StoreRepository {
  listForUser(userId: string) {
    return prisma.store.findMany({
      where: { memberships: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        myshopifyDomain: true,
        currencyCode: true,
        ianaTimezone: true,
        createdAt: true,
        memberships: {
          where: { userId },
          select: { role: true },
        },
        // The application shell only needs compact provider/Pixel readiness and freshness. Keep
        // this on the already-required Store summary so feature pages do not perform standalone
        // status reads before they can load their actual data.
        shopifyConnection: { select: { status: true, lastSyncedAt: true } },
        metaConnection: { select: { status: true, lastSyncedAt: true } },
        tiktokConnection: { select: { status: true, lastSyncedAt: true } },
        pixelInstallation: {
          select: { status: true, lastEventAt: true, lastError: true },
        },
      },
    });
  }

  findById(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        myshopifyDomain: true,
        currencyCode: true,
        ianaTimezone: true,
        primaryDomainHost: true,
        primaryDomainUrl: true,
        enabledPresentmentCurrencies: true,
        createdAt: true,
        updatedAt: true,
        shopifyConnection: { select: { status: true, lastSyncedAt: true } },
        metaConnection: { select: { status: true, lastSyncedAt: true } },
        tiktokConnection: { select: { status: true, lastSyncedAt: true } },
        pixelInstallation: {
          select: { status: true, lastEventAt: true, lastError: true },
        },
      },
    });
  }
}
