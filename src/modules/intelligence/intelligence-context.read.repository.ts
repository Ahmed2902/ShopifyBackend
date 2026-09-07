import { prisma } from '../../lib/prisma.js';

/**
 * Compact tenant/integration metadata required to plan one intelligence snapshot.
 *
 * Keep freshness metadata with the context read so the service does not spend a separate query
 * discovering the latest successful Shopify order-history import after it already loaded the
 * Shopify connection.
 */
export class IntelligenceContextReadRepository {
  async getContext(storeId: string) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        currencyCode: true,
        ianaTimezone: true,
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
        shopifyConnection: {
          select: {
            status: true,
            scopes: true,
            lastSyncedAt: true,
            syncRuns: {
              where: {
                provider: 'SHOPIFY',
                resourceType: 'OrdersRefunds',
                status: 'SUCCEEDED',
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                status: true,
                recordsRead: true,
                recordsWritten: true,
                finishedAt: true,
              },
            },
          },
        },
        metaConnection: {
          select: {
            status: true,
            selectedAdAccountIds: true,
          },
        },
      },
    });

    if (!store) return null;
    const { syncRuns, ...shopifyConnection } = store.shopifyConnection ?? { syncRuns: [] };
    return {
      ...store,
      shopifyConnection: store.shopifyConnection ? shopifyConnection : null,
      successfulOrderHistorySync: syncRuns[0] ?? null,
    };
  }
}

export const intelligenceContextReadRepository = new IntelligenceContextReadRepository();
