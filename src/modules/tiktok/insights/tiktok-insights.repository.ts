import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import { advertisingWriteRepository } from '../../advertising/advertising-write.repository.js';

function metricLevel(level: 'ADVERTISER' | 'CAMPAIGN' | 'ADGROUP' | 'AD') {
  if (level === 'ADVERTISER') return 'ACCOUNT' as const;
  if (level === 'CAMPAIGN') return 'CAMPAIGN' as const;
  if (level === 'ADGROUP') return 'GROUP' as const;
  return 'AD' as const;
}

export class TikTokInsightsRepository {
  private async selectedAdvertiserIds(storeId: string): Promise<string[]> {
    const connection = await prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: { selectedAdvertiserIds: true },
    });
    return connection?.selectedAdvertiserIds ?? [];
  }

  private async upsertInsightTx(
    tx: Prisma.TransactionClient,
    input: Prisma.TikTokInsightDailyUncheckedCreateInput,
  ) {
    const { insightKey, id: _id, createdAt: _createdAt, ...update } = input;
    const native = await tx.tikTokInsightDaily.upsert({
      where: { insightKey },
      create: input,
      update,
    });
    await advertisingWriteRepository.upsertDailyMetric(tx, {
      id: native.id,
      metricKey: `TIKTOK:${native.insightKey}`,
      accountId: native.advertiserDbId,
      campaignId: native.campaignId,
      groupId: native.adGroupId,
      adId: native.adId,
      creativeIdSnapshot: null,
      level: metricLevel(native.level),
      date: native.date,
      currency: native.accountCurrency,
      spend: native.spend.toString(),
      impressions: native.impressions,
      reach: native.reach,
      clicks: native.clicks,
      conversions: native.conversions?.toString() ?? null,
      conversionValue: native.conversionValue?.toString() ?? null,
      ctr: native.ctr?.toString() ?? null,
      cpc: native.cpc?.toString() ?? null,
      cpm: native.cpm?.toString() ?? null,
      frequency: native.frequency?.toString() ?? null,
      cpa: native.costPerConversion?.toString() ?? null,
      roas: native.roas?.toString() ?? null,
      providerMetrics: {
        resultCount: native.resultCount,
        costPerResult: native.costPerResult,
        videoPlayActions: native.videoPlayActions,
        videoWatched2s: native.videoWatched2s,
        videoWatched6s: native.videoWatched6s,
        videoViewsP25: native.videoViewsP25,
        videoViewsP50: native.videoViewsP50,
        videoViewsP75: native.videoViewsP75,
        videoViewsP100: native.videoViewsP100,
        likes: native.likes,
        comments: native.comments,
        shares: native.shares,
        follows: native.follows,
        profileVisits: native.profileVisits,
        objectiveType: native.objectiveType,
        optimizationGoal: native.optimizationGoal,
        attributionWindow: native.attributionWindow,
        dimensions: native.dimensionsJson,
        metrics: native.metricsJson,
      },
      breakdownJson: native.dimensionsJson,
      rawJson: native.rawJson,
      syncedAt: native.syncedAt,
    });
    return native;
  }

  upsertInsight(input: Prisma.TikTokInsightDailyUncheckedCreateInput) {
    return prisma.$transaction((tx) => this.upsertInsightTx(tx, input));
  }

  /**
   * Bounded batch write used by report ingestion. Native and canonical facts are committed in the
   * same transaction so a failed canonical projection cannot leave the native row ahead of the
   * production read model (or vice versa).
   */
  upsertInsights(inputs: Prisma.TikTokInsightDailyUncheckedCreateInput[]) {
    if (inputs.length === 0) return Promise.resolve([]);
    return prisma.$transaction(async (tx) => {
      const written = [];
      for (const input of inputs) written.push(await this.upsertInsightTx(tx, input));
      return written;
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
