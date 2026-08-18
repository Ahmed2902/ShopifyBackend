import { prisma } from '../../lib/prisma.js';

export class StoreRepository {
  findMembership(userId: string, storeId: string) {
    return prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { storeId: true, role: true },
    });
  }

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
        shopifyConnection: { select: { status: true } },
        metaConnection: { select: { status: true } },
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
      },
    });
  }
}
