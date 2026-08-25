import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

export class TikTokInsightsRepository {
  private async selectedAdvertiserIds(storeId: string): Promise<string[]> {
    const connection = await prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: { selectedAdvertiserIds: true },
    });
    return connection?.selectedAdvertiserIds ?? [];
  }

  upsertInsight(input: Prisma.TikTokInsightDailyUncheckedCreateInput) {
    const { insightKey, id: _id, createdAt: _createdAt, ...update } = input;
    return prisma.tikTokInsightDaily.upsert({
      where: { insightKey },
      create: input,
      update,
    });
  }

  async listInsights(storeId: string, input: {
    page: number;
    limit: number;
    from: Date;
    to: Date;
    advertiserId?: string;
    campaignId?: string;
    adGroupId?: string;
    adId?: string;
  }) {
    const selectedAdvertiserIds = await this.selectedAdvertiserIds(storeId);
    if (selectedAdvertiserIds.length === 0) return [[], 0] as const;
    if (input.advertiserId && !selectedAdvertiserIds.includes(input.advertiserId)) return [[], 0] as const;

    const where: Prisma.TikTokInsightDailyWhereInput = {
      advertiser: {
        storeId,
        advertiserId: input.advertiserId ?? { in: selectedAdvertiserIds },
      },
      date: { gte: input.from, lte: input.to },
      ...(input.campaignId ? { campaign: { tiktokCampaignId: input.campaignId } } : {}),
      ...(input.adGroupId ? { adGroup: { tiktokAdGroupId: input.adGroupId } } : {}),
      ...(input.adId ? { ad: { tiktokAdId: input.adId } } : {}),
    };
    return Promise.all([
      prisma.tikTokInsightDaily.findMany({
        where,
        include: {
          advertiser: { select: { advertiserId: true } },
          campaign: { select: { tiktokCampaignId: true, name: true } },
          adGroup: { select: { tiktokAdGroupId: true, name: true } },
          ad: { select: { tiktokAdId: true, name: true } },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.tikTokInsightDaily.count({ where }),
    ]);
  }
}
