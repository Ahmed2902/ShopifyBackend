import { prisma } from '../../../lib/prisma.js';

export class MetaTrackingRepository {
  private async selectedAdAccountIds(storeId: string): Promise<string[]> {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    return connection?.selectedAdAccountIds ?? [];
  }

  async findAds(storeId: string) {
    const selectedAdAccountIds = await this.selectedAdAccountIds(storeId);
    if (selectedAdAccountIds.length === 0) return [];

    return prisma.metaAd.findMany({
      where: {
        deletedAt: null,
        adAccount: {
          storeId,
          metaAccountId: { in: selectedAdAccountIds },
        },
      },
      select: {
        metaAdId: true,
        name: true,
        configuredStatus: true,
        effectiveStatus: true,
        adAccount: {
          select: {
            metaAccountId: true,
          },
        },
        campaign: {
          select: {
            metaCampaignId: true,
          },
        },
        adSet: {
          select: {
            metaAdSetId: true,
            isDynamicCreative: true,
          },
        },
        creative: {
          select: {
            metaCreativeId: true,
            name: true,
            objectStoryId: true,
            objectStorySpec: true,
            assetFeedSpec: true,
            degreesOfFreedomSpec: true,
            urlTags: true,
          },
        },
      },
      orderBy: [{ effectiveStatus: 'asc' }, { name: 'asc' }],
    });
  }
}

export type MetaTrackingAd = Awaited<ReturnType<MetaTrackingRepository['findAds']>>[number];
