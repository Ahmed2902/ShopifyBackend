import { prisma } from '../../../lib/prisma.js';
export class TikTokTrackingRepository {
  findAds(storeId: string, advertiserIds: string[]) {
    return prisma.tikTokAd.findMany({
      where: {
        deletedAt: null,
        advertiser: { storeId, advertiserId: { in: advertiserIds } },
        campaign: { deletedAt: null },
        adGroup: { deletedAt: null },
      },
      select: {
        tiktokAdId: true,
        name: true,
        landingPageUrl: true,
        rawJson: true,
        advertiser: { select: { advertiserId: true } },
        campaign: { select: { tiktokCampaignId: true, isSmartPerformance: true } },
        adGroup: { select: { tiktokAdGroupId: true } },
      },
      orderBy: { name: 'asc' },
      take: 1001,
    });
  }
}
export type TikTokTrackingAd = Awaited<ReturnType<TikTokTrackingRepository['findAds']>>[number];
