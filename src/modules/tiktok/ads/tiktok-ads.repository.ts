import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import { advertisingWriteRepository } from '../../advertising/advertising-write.repository.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const optionalJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : json(value);

export class TikTokAdsRepository {
  private async selectedAdvertiserIds(storeId: string): Promise<string[]> {
    const connection = await prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: { selectedAdvertiserIds: true },
    });
    return connection?.selectedAdvertiserIds ?? [];
  }

  findSelectedAdvertisers(storeId: string, advertiserIds: string[]) {
    return prisma.tikTokAdvertiser.findMany({
      where: { storeId, advertiserId: { in: advertiserIds } },
      orderBy: { name: 'asc' },
    });
  }

  upsertCampaign(input: {
    advertiserDbId: string;
    tiktokCampaignId: string;
    name: string;
    objectiveType?: string | null;
    campaignType?: string | null;
    operationStatus?: string | null;
    secondaryStatus?: string | null;
    budgetMode?: string | null;
    budget?: string | number | null;
    deepBidType?: string | null;
    roasBid?: string | number | null;
    isSmartPerformance?: boolean | null;
    tiktokCreatedAt?: Date | null;
    tiktokUpdatedAt?: Date | null;
    raw: unknown;
  }) {
    const data = {
      name: input.name,
      objectiveType: input.objectiveType,
      campaignType: input.campaignType,
      operationStatus: input.operationStatus,
      secondaryStatus: input.secondaryStatus,
      budgetMode: input.budgetMode,
      budget: input.budget,
      deepBidType: input.deepBidType,
      roasBid: input.roasBid,
      isSmartPerformance: input.isSmartPerformance,
      tiktokCreatedAt: input.tiktokCreatedAt,
      tiktokUpdatedAt: input.tiktokUpdatedAt,
      deletedAt: null,
      rawJson: json(input.raw),
    };
    return prisma.$transaction(async (tx) => {
      const native = await tx.tikTokCampaign.upsert({
        where: { advertiserDbId_tiktokCampaignId: { advertiserDbId: input.advertiserDbId, tiktokCampaignId: input.tiktokCampaignId } },
        create: { advertiserDbId: input.advertiserDbId, tiktokCampaignId: input.tiktokCampaignId, ...data },
        update: data,
      });
      await advertisingWriteRepository.upsertCampaign(tx, {
        id: native.id,
        accountId: input.advertiserDbId,
        providerEntityId: input.tiktokCampaignId,
        name: input.name,
        status: input.operationStatus,
        effectiveStatus: input.secondaryStatus,
        objective: input.objectiveType,
        campaignType: input.campaignType,
        budgetAmount: input.budget,
        budgetMode: input.budgetMode,
        bidStrategy: input.deepBidType,
        providerData: {
          roasBid: input.roasBid,
          isSmartPerformance: input.isSmartPerformance,
        },
        rawJson: input.raw,
        providerCreatedAt: input.tiktokCreatedAt,
        providerUpdatedAt: input.tiktokUpdatedAt,
        deletedAt: null,
      });
      return native;
    });
  }

  tombstoneMissingCampaigns(advertiserDbId: string, activeIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const externalFilter = activeIds.length > 0 ? { providerEntityId: { notIn: activeIds } } : {};
      const [native] = await Promise.all([
        tx.tikTokCampaign.updateMany({
          where: {
            advertiserDbId,
            deletedAt: null,
            ...(activeIds.length > 0 ? { tiktokCampaignId: { notIn: activeIds } } : {}),
          },
          data: { deletedAt: now },
        }),
        tx.advertisingCampaign.updateMany({
          where: { accountId: advertiserDbId, deletedAt: null, ...externalFilter },
          data: { deletedAt: now },
        }),
      ]);
      return native;
    });
  }

  upsertAdGroup(input: {
    advertiserDbId: string;
    campaignId: string;
    tiktokAdGroupId: string;
    name: string;
    operationStatus?: string | null;
    secondaryStatus?: string | null;
    placementType?: string | null;
    placements?: unknown;
    promotionType?: string | null;
    optimizationGoal?: string | null;
    optimizationEvent?: string | null;
    billingEvent?: string | null;
    bidType?: string | null;
    bidPrice?: string | number | null;
    deepBidType?: string | null;
    roasBid?: string | number | null;
    budgetMode?: string | null;
    budget?: string | number | null;
    scheduleType?: string | null;
    scheduleStartTime?: Date | null;
    scheduleEndTime?: Date | null;
    dayparting?: string | null;
    pixelId?: string | null;
    catalogId?: string | null;
    productSetId?: string | null;
    productSource?: string | null;
    targeting?: unknown;
    attribution?: unknown;
    tiktokCreatedAt?: Date | null;
    tiktokUpdatedAt?: Date | null;
    raw: unknown;
  }) {
    const data = {
      campaignId: input.campaignId,
      name: input.name,
      operationStatus: input.operationStatus,
      secondaryStatus: input.secondaryStatus,
      placementType: input.placementType,
      placements: optionalJson(input.placements),
      promotionType: input.promotionType,
      optimizationGoal: input.optimizationGoal,
      optimizationEvent: input.optimizationEvent,
      billingEvent: input.billingEvent,
      bidType: input.bidType,
      bidPrice: input.bidPrice,
      deepBidType: input.deepBidType,
      roasBid: input.roasBid,
      budgetMode: input.budgetMode,
      budget: input.budget,
      scheduleType: input.scheduleType,
      scheduleStartTime: input.scheduleStartTime,
      scheduleEndTime: input.scheduleEndTime,
      dayparting: input.dayparting,
      pixelId: input.pixelId,
      catalogId: input.catalogId,
      productSetId: input.productSetId,
      productSource: input.productSource,
      targeting: optionalJson(input.targeting),
      attribution: optionalJson(input.attribution),
      tiktokCreatedAt: input.tiktokCreatedAt,
      tiktokUpdatedAt: input.tiktokUpdatedAt,
      deletedAt: null,
      rawJson: json(input.raw),
    };
    return prisma.$transaction(async (tx) => {
      const native = await tx.tikTokAdGroup.upsert({
        where: { advertiserDbId_tiktokAdGroupId: { advertiserDbId: input.advertiserDbId, tiktokAdGroupId: input.tiktokAdGroupId } },
        create: { advertiserDbId: input.advertiserDbId, tiktokAdGroupId: input.tiktokAdGroupId, ...data },
        update: data,
      });
      await advertisingWriteRepository.upsertGroup(tx, {
        id: native.id,
        accountId: input.advertiserDbId,
        campaignId: input.campaignId,
        providerEntityId: input.tiktokAdGroupId,
        kind: 'AD_GROUP',
        name: input.name,
        status: input.operationStatus,
        effectiveStatus: input.secondaryStatus,
        optimizationGoal: input.optimizationGoal,
        billingEvent: input.billingEvent,
        bidStrategy: input.bidType,
        bidAmount: input.bidPrice,
        budgetAmount: input.budget,
        budgetMode: input.budgetMode,
        targeting: input.targeting,
        startsAt: input.scheduleStartTime,
        endsAt: input.scheduleEndTime,
        providerData: {
          placementType: input.placementType,
          placements: input.placements,
          promotionType: input.promotionType,
          optimizationEvent: input.optimizationEvent,
          deepBidType: input.deepBidType,
          roasBid: input.roasBid,
          scheduleType: input.scheduleType,
          dayparting: input.dayparting,
          pixelId: input.pixelId,
          catalogId: input.catalogId,
          productSetId: input.productSetId,
          productSource: input.productSource,
          attribution: input.attribution,
        },
        rawJson: input.raw,
        providerCreatedAt: input.tiktokCreatedAt,
        providerUpdatedAt: input.tiktokUpdatedAt,
        deletedAt: null,
      });
      return native;
    });
  }

  tombstoneMissingAdGroups(advertiserDbId: string, activeIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const externalFilter = activeIds.length > 0 ? { providerEntityId: { notIn: activeIds } } : {};
      const [native] = await Promise.all([
        tx.tikTokAdGroup.updateMany({
          where: {
            advertiserDbId,
            deletedAt: null,
            ...(activeIds.length > 0 ? { tiktokAdGroupId: { notIn: activeIds } } : {}),
          },
          data: { deletedAt: now },
        }),
        tx.advertisingGroup.updateMany({
          where: { accountId: advertiserDbId, kind: 'AD_GROUP', deletedAt: null, ...externalFilter },
          data: { deletedAt: now },
        }),
      ]);
      return native;
    });
  }

  upsertAd(input: {
    advertiserDbId: string;
    campaignId: string;
    adGroupId: string;
    tiktokAdId: string;
    name: string;
    operationStatus?: string | null;
    secondaryStatus?: string | null;
    adFormat?: string | null;
    creativeMaterialMode?: string | null;
    identityId?: string | null;
    identityType?: string | null;
    sparkAdPostId?: string | null;
    videoId?: string | null;
    imageIds?: unknown;
    thumbnailUrl?: string | null;
    adText?: string | null;
    displayName?: string | null;
    callToAction?: string | null;
    landingPageUrl?: string | null;
    trackingPixelId?: string | null;
    catalogId?: string | null;
    productSetId?: string | null;
    tracking?: unknown;
    creativeJson?: unknown;
    tiktokCreatedAt?: Date | null;
    tiktokUpdatedAt?: Date | null;
    raw: unknown;
  }) {
    const data = {
      campaignId: input.campaignId,
      adGroupId: input.adGroupId,
      name: input.name,
      operationStatus: input.operationStatus,
      secondaryStatus: input.secondaryStatus,
      adFormat: input.adFormat,
      creativeMaterialMode: input.creativeMaterialMode,
      identityId: input.identityId,
      identityType: input.identityType,
      sparkAdPostId: input.sparkAdPostId,
      videoId: input.videoId,
      imageIds: optionalJson(input.imageIds),
      thumbnailUrl: input.thumbnailUrl,
      adText: input.adText,
      displayName: input.displayName,
      callToAction: input.callToAction,
      landingPageUrl: input.landingPageUrl,
      trackingPixelId: input.trackingPixelId,
      catalogId: input.catalogId,
      productSetId: input.productSetId,
      tracking: optionalJson(input.tracking),
      creativeJson: optionalJson(input.creativeJson),
      tiktokCreatedAt: input.tiktokCreatedAt,
      tiktokUpdatedAt: input.tiktokUpdatedAt,
      deletedAt: null,
      rawJson: json(input.raw),
    };
    return prisma.$transaction(async (tx) => {
      const native = await tx.tikTokAd.upsert({
        where: { advertiserDbId_tiktokAdId: { advertiserDbId: input.advertiserDbId, tiktokAdId: input.tiktokAdId } },
        create: { advertiserDbId: input.advertiserDbId, tiktokAdId: input.tiktokAdId, ...data },
        update: data,
      });
      await advertisingWriteRepository.upsertAd(tx, {
        id: native.id,
        accountId: input.advertiserDbId,
        campaignId: input.campaignId,
        groupId: input.adGroupId,
        creativeId: null,
        providerEntityId: input.tiktokAdId,
        name: input.name,
        status: input.operationStatus,
        effectiveStatus: input.secondaryStatus,
        format: input.adFormat,
        landingPageUrl: input.landingPageUrl,
        targetScope: native.targetScope,
        targetScopeConfidence: native.targetScopeConfidence,
        targetScopeEvidence: native.targetScopeEvidence,
        providerData: {
          creativeMaterialMode: input.creativeMaterialMode,
          identityId: input.identityId,
          identityType: input.identityType,
          sparkAdPostId: input.sparkAdPostId,
          videoId: input.videoId,
          imageIds: input.imageIds,
          thumbnailUrl: input.thumbnailUrl,
          adText: input.adText,
          displayName: input.displayName,
          callToAction: input.callToAction,
          trackingPixelId: input.trackingPixelId,
          catalogId: input.catalogId,
          productSetId: input.productSetId,
          tracking: input.tracking,
          creativeJson: input.creativeJson,
        },
        rawJson: input.raw,
        providerCreatedAt: input.tiktokCreatedAt,
        providerUpdatedAt: input.tiktokUpdatedAt,
        deletedAt: null,
      });
      return native;
    });
  }

  tombstoneMissingAds(advertiserDbId: string, activeIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const externalFilter = activeIds.length > 0 ? { providerEntityId: { notIn: activeIds } } : {};
      const [native] = await Promise.all([
        tx.tikTokAd.updateMany({
          where: {
            advertiserDbId,
            deletedAt: null,
            ...(activeIds.length > 0 ? { tiktokAdId: { notIn: activeIds } } : {}),
          },
          data: { deletedAt: now },
        }),
        tx.advertisingAd.updateMany({
          where: { accountId: advertiserDbId, deletedAt: null, ...externalFilter },
          data: { deletedAt: now },
        }),
      ]);
      return native;
    });
  }

  async listCampaigns(storeId: string, input: { page: number; limit: number; advertiserId?: string; status?: string }) {
    const selectedAdvertiserIds = await this.selectedAdvertiserIds(storeId);
    if (selectedAdvertiserIds.length === 0) return [[], 0] as const;
    if (input.advertiserId && !selectedAdvertiserIds.includes(input.advertiserId)) return [[], 0] as const;

    const where: Prisma.TikTokCampaignWhereInput = {
      advertiser: {
        storeId,
        advertiserId: input.advertiserId ?? { in: selectedAdvertiserIds },
      },
      deletedAt: null,
      ...(input.status ? { operationStatus: input.status } : {}),
    };
    return Promise.all([
      prisma.tikTokCampaign.findMany({
        where,
        include: { advertiser: { select: { advertiserId: true, name: true, currency: true, timezone: true } } },
        orderBy: { tiktokUpdatedAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.tikTokCampaign.count({ where }),
    ]);
  }

  async listAdGroups(storeId: string, input: { page: number; limit: number; campaignId?: string; status?: string }) {
    const selectedAdvertiserIds = await this.selectedAdvertiserIds(storeId);
    if (selectedAdvertiserIds.length === 0) return [[], 0] as const;

    const where: Prisma.TikTokAdGroupWhereInput = {
      advertiser: { storeId, advertiserId: { in: selectedAdvertiserIds } },
      deletedAt: null,
      ...(input.campaignId ? { campaign: { tiktokCampaignId: input.campaignId } } : {}),
      ...(input.status ? { operationStatus: input.status } : {}),
    };
    return Promise.all([
      prisma.tikTokAdGroup.findMany({
        where,
        include: {
          campaign: { select: { tiktokCampaignId: true, name: true } },
          advertiser: { select: { advertiserId: true } },
        },
        orderBy: { tiktokUpdatedAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.tikTokAdGroup.count({ where }),
    ]);
  }

  async listAds(storeId: string, input: { page: number; limit: number; campaignId?: string; adGroupId?: string; status?: string }) {
    const selectedAdvertiserIds = await this.selectedAdvertiserIds(storeId);
    if (selectedAdvertiserIds.length === 0) return [[], 0] as const;

    const where: Prisma.TikTokAdWhereInput = {
      advertiser: { storeId, advertiserId: { in: selectedAdvertiserIds } },
      deletedAt: null,
      ...(input.campaignId ? { campaign: { tiktokCampaignId: input.campaignId } } : {}),
      ...(input.adGroupId ? { adGroup: { tiktokAdGroupId: input.adGroupId } } : {}),
      ...(input.status ? { operationStatus: input.status } : {}),
    };
    return Promise.all([
      prisma.tikTokAd.findMany({
        where,
        include: {
          campaign: { select: { tiktokCampaignId: true, name: true } },
          adGroup: { select: { tiktokAdGroupId: true, name: true } },
          advertiser: { select: { advertiserId: true } },
          productMappings: {
            where: { validUntil: null },
            include: { product: true, variant: true, catalogItem: true },
          },
        },
        orderBy: { tiktokUpdatedAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.tikTokAd.count({ where }),
    ]);
  }

  async getAd(storeId: string, tiktokAdId: string) {
    const selectedAdvertiserIds = await this.selectedAdvertiserIds(storeId);
    if (selectedAdvertiserIds.length === 0) return null;

    return prisma.tikTokAd.findFirst({
      where: {
        tiktokAdId,
        advertiser: { storeId, advertiserId: { in: selectedAdvertiserIds } },
        deletedAt: null,
      },
      include: {
        advertiser: true,
        campaign: true,
        adGroup: true,
        insights: { orderBy: { date: 'desc' }, take: 30 },
        productMappings: {
          where: { validUntil: null },
          include: { product: true, variant: true, catalogItem: true },
        },
      },
    });
  }
}
