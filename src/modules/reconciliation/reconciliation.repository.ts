import { prisma } from '../../lib/prisma.js';

export class ReconciliationRepository {
  async listDueShopifyConnectionIds(
    limit: number,
    now: Date,
    staleBefore: Date,
  ): Promise<string[]> {
    const rows = await prisma.shopifyConnection.findMany({
      where: {
        status: 'ACTIVE',
        nextReconciliationAt: { lte: now },
        OR: [
          { reconciliationClaimedAt: null },
          { reconciliationClaimedAt: { lte: staleBefore } },
        ],
      },
      orderBy: [{ nextReconciliationAt: 'asc' }, { installedAt: 'asc' }],
      select: { id: true },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async tryClaimShopify(
    connectionId: string,
    now: Date,
    staleBefore: Date,
  ): Promise<{ claimed: false } | { claimed: true; storeId: string }> {
    const claimed = await prisma.shopifyConnection.updateMany({
      where: {
        id: connectionId,
        status: 'ACTIVE',
        nextReconciliationAt: { lte: now },
        OR: [
          { reconciliationClaimedAt: null },
          { reconciliationClaimedAt: { lte: staleBefore } },
        ],
      },
      data: { reconciliationClaimedAt: now },
    });
    if (claimed.count !== 1) return { claimed: false };

    const connection = await prisma.shopifyConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: { storeId: true },
    });
    return { claimed: true, storeId: connection.storeId };
  }

  markShopifyFailed(connectionId: string, retryAt: Date) {
    return prisma.shopifyConnection.updateMany({
      where: { id: connectionId },
      data: {
        reconciliationClaimedAt: null,
        nextReconciliationAt: retryAt,
      },
    });
  }
}
