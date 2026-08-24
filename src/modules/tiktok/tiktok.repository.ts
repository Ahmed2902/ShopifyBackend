import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const optionalJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : json(value);

export class TikTokRepository {
  findMembership(userId: string, storeId: string) {
    return prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { role: true },
    });
  }

  upsertConnection(input: {
    storeId: string;
    accessTokenCiphertext: string;
    scopes: string[];
    apiVersion: string;
  }) {
    return prisma.tikTokConnection.upsert({
      where: { storeId: input.storeId },
      create: {
        storeId: input.storeId,
        status: 'ACTIVE',
        accessTokenCiphertext: input.accessTokenCiphertext,
        scopes: input.scopes,
        apiVersion: input.apiVersion,
      },
      update: {
        status: 'ACTIVE',
        accessTokenCiphertext: input.accessTokenCiphertext,
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        refreshTokenExpiresAt: null,
        scopes: input.scopes,
        apiVersion: input.apiVersion,
      },
      select: { id: true, storeId: true, status: true, scopes: true },
    });
  }

  findConnectionForStore(storeId: string) {
    return prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: {
        id: true,
        storeId: true,
        status: true,
        openId: true,
        businessCenterId: true,
        selectedAdvertiserIds: true,
        selectedCatalogIds: true,
        accessTokenCiphertext: true,
        accessTokenExpiresAt: true,
        refreshTokenCiphertext: true,
        refreshTokenExpiresAt: true,
        scopes: true,
        apiVersion: true,
        lastSyncedAt: true,
      },
    });
  }

  private async selectedAdvertiserIds(storeId: string): Promise<string[]> {
    const connection = await prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: { selectedAdvertiserIds: true },
    });
    return connection?.selectedAdvertiserIds ?? [];
  }

  markConnectionReauthRequired(id: string) {
    return prisma.tikTokConnection.update({ where: { id }, data: { status: 'REAUTH_REQUIRED' } });
  }

  configureAssets(connectionId: string, businessCenterId: string | null, advertiserIds: string[]) {
    return prisma.tikTokConnection.update({
      where: { id: connectionId },
      data: { businessCenterId, selectedAdvertiserIds: advertiserIds },
    });
  }

  configureCatalogs(connectionId: string, catalogIds: string[]) {
    return prisma.tikTokConnection.update({
      where: { id: connectionId },
      data: { selectedCatalogIds: catalogIds },
    });
  }

  markConnectionSynced(connectionId: string) {
    return prisma.tikTokConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: new Date() },
    });
  }

  upsertAdvertiser(input: {
    storeId: string;
    connectionId: string;
    advertiserId: string;
    name: string;
    status?: string | null;
    currency?: string | null;
    timezone?: string | null;
    countryCode?: string | null;
    industry?: string | null;
    company?: string | null;
    balance?: string | number | null;
    raw: unknown;
  }) {
    const data = {
      tiktokConnectionId: input.connectionId,
      name: input.name,
      status: input.status,
      currency: input.currency,
      timezone: input.timezone,
      countryCode: input.countryCode,
      industry: input.industry,
      company: input.company,
      balance: input.balance,
      lastSyncedAt: new Date(),
      rawJson: json(input.raw),
    };
    return prisma.tikTokAdvertiser.upsert({
      where: { storeId_advertiserId: { storeId: input.storeId, advertiserId: input.advertiserId } },
      create: { storeId: input.storeId, advertiserId: input.advertiserId, ...data },
      update: data,
    });
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
    return prisma.tikTokCampaign.upsert({
      where: { advertiserDbId_tiktokCampaignId: { advertiserDbId: input.advertiserDbId, tiktokCampaignId: input.tiktokCampaignId } },
      create: { advertiserDbId: input.advertiserDbId, tiktokCampaignId: input.tiktokCampaignId, ...data },
      update: data,
    });
  }

  tombstoneMissingCampaigns(advertiserDbId: string, activeIds: string[]) {
    return prisma.tikTokCampaign.updateMany({
      where: {
        advertiserDbId,
        deletedAt: null,
        ...(activeIds.length > 0 ? { tiktokCampaignId: { notIn: activeIds } } : {}),
      },
      data: { deletedAt: new Date() },
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
    return prisma.tikTokAdGroup.upsert({
      where: { advertiserDbId_tiktokAdGroupId: { advertiserDbId: input.advertiserDbId, tiktokAdGroupId: input.tiktokAdGroupId } },
      create: { advertiserDbId: input.advertiserDbId, tiktokAdGroupId: input.tiktokAdGroupId, ...data },
      update: data,
    });
  }

  tombstoneMissingAdGroups(advertiserDbId: string, activeIds: string[]) {
    return prisma.tikTokAdGroup.updateMany({
      where: {
        advertiserDbId,
        deletedAt: null,
        ...(activeIds.length > 0 ? { tiktokAdGroupId: { notIn: activeIds } } : {}),
      },
      data: { deletedAt: new Date() },
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
    return prisma.tikTokAd.upsert({
      where: { advertiserDbId_tiktokAdId: { advertiserDbId: input.advertiserDbId, tiktokAdId: input.tiktokAdId } },
      create: { advertiserDbId: input.advertiserDbId, tiktokAdId: input.tiktokAdId, ...data },
      update: data,
    });
  }

  updateAdTargetScope(
    id: string,
    targetScope: 'STORE' | 'COLLECTION' | 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT' | 'MULTI_PRODUCT' | 'UNKNOWN',
    confidence: number,
    evidence: unknown,
  ) {
    return prisma.tikTokAd.update({
      where: { id },
      data: {
        targetScope,
        targetScopeConfidence: confidence,
        targetScopeEvidence: json(evidence),
      },
    });
  }

  tombstoneMissingAds(advertiserDbId: string, activeIds: string[]) {
    return prisma.tikTokAd.updateMany({
      where: {
        advertiserDbId,
        deletedAt: null,
        ...(activeIds.length > 0 ? { tiktokAdId: { notIn: activeIds } } : {}),
      },
      data: { deletedAt: new Date() },
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

  upsertCatalog(input: {
    storeId: string;
    connectionId: string;
    tiktokCatalogId: string;
    name: string;
    businessCenterId?: string | null;
    catalogType?: string | null;
    vertical?: string | null;
    region?: string | null;
    currency?: string | null;
    productCount?: number | null;
    raw: unknown;
  }) {
    const data = {
      tiktokConnectionId: input.connectionId,
      name: input.name,
      businessCenterId: input.businessCenterId,
      catalogType: input.catalogType,
      vertical: input.vertical,
      region: input.region,
      currency: input.currency,
      productCount: input.productCount,
      lastSyncedAt: new Date(),
      rawJson: json(input.raw),
    };
    return prisma.tikTokCatalog.upsert({
      where: { storeId_tiktokCatalogId: { storeId: input.storeId, tiktokCatalogId: input.tiktokCatalogId } },
      create: { storeId: input.storeId, tiktokCatalogId: input.tiktokCatalogId, ...data },
      update: data,
    });
  }

  listCatalogs(storeId: string) {
    return prisma.tikTokCatalog.findMany({ where: { storeId }, orderBy: { name: 'asc' } });
  }

  upsertCatalogItem(input: {
    catalogId: string;
    tiktokProductId: string;
    retailerId?: string | null;
    itemGroupId?: string | null;
    title?: string | null;
    description?: string | null;
    brand?: string | null;
    availability?: string | null;
    price?: string | number | null;
    salePrice?: string | number | null;
    currency?: string | null;
    size?: string | null;
    color?: string | null;
    pattern?: string | null;
    url?: string | null;
    imageUrl?: string | null;
    productType?: string | null;
    category?: string | null;
    customLabels?: unknown;
    variants?: unknown;
    videoIds?: unknown;
    status?: string | null;
    raw: unknown;
  }) {
    const data = {
      retailerId: input.retailerId,
      itemGroupId: input.itemGroupId,
      title: input.title,
      description: input.description,
      brand: input.brand,
      availability: input.availability,
      price: input.price,
      salePrice: input.salePrice,
      currency: input.currency,
      size: input.size,
      color: input.color,
      pattern: input.pattern,
      url: input.url,
      imageUrl: input.imageUrl,
      productType: input.productType,
      category: input.category,
      customLabels: optionalJson(input.customLabels),
      variants: optionalJson(input.variants),
      videoIds: optionalJson(input.videoIds),
      status: input.status,
      deletedAt: null,
      rawJson: json(input.raw),
    };
    return prisma.tikTokCatalogItem.upsert({
      where: { catalogId_tiktokProductId: { catalogId: input.catalogId, tiktokProductId: input.tiktokProductId } },
      create: { catalogId: input.catalogId, tiktokProductId: input.tiktokProductId, ...data },
      update: data,
    });
  }

  tombstoneMissingCatalogItems(catalogId: string, activeIds: string[]) {
    return prisma.tikTokCatalogItem.updateMany({
      where: {
        catalogId,
        deletedAt: null,
        ...(activeIds.length > 0 ? { tiktokProductId: { notIn: activeIds } } : {}),
      },
      data: { deletedAt: new Date() },
    });
  }

  listCatalogItems(storeId: string, tiktokCatalogId: string, page: number, limit: number) {
    const where: Prisma.TikTokCatalogItemWhereInput = {
      catalog: { storeId, tiktokCatalogId },
      deletedAt: null,
    };
    return Promise.all([
      prisma.tikTokCatalogItem.findMany({
        where,
        include: {
          variantMappings: {
            where: { validUntil: null },
            include: { variant: { include: { product: true, options: true } } },
          },
        },
        orderBy: { title: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.tikTokCatalogItem.count({ where }),
    ]);
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

  getMappingDataset(storeId: string, selectedCatalogIds: string[], selectedAdvertiserIds: string[]) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        myshopifyDomain: true,
        primaryDomainHost: true,
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            shopifyVariantId: true,
            sku: true,
            barcode: true,
            productId: true,
            options: true,
            product: { select: { shopifyProductId: true, title: true, handle: true } },
          },
        },
        tiktokCatalogs: {
          where: { tiktokCatalogId: { in: selectedCatalogIds } },
          select: {
            items: {
              where: { deletedAt: null },
              select: {
                id: true,
                tiktokProductId: true,
                retailerId: true,
                itemGroupId: true,
                title: true,
                size: true,
                color: true,
                pattern: true,
                url: true,
              },
            },
          },
        },
        tiktokAdvertisers: {
          where: { advertiserId: { in: selectedAdvertiserIds } },
          select: {
            ads: {
              where: { deletedAt: null },
              select: {
                id: true,
                tiktokAdId: true,
                landingPageUrl: true,
                catalogId: true,
                productSetId: true,
                creativeJson: true,
                rawJson: true,
              },
            },
          },
        },
      },
    });
  }

  async replaceAutomaticCatalogMappings(
    catalogItemId: string,
    mappings: Array<{
      variantId: string;
      source: 'RETAILER_ID_SKU' | 'URL' | 'PRODUCT_GROUP' | 'INFERRED';
      confidence: number;
    }>,
  ) {
    return prisma.$transaction(async (tx) => {
      const confirmed = await tx.tikTokCatalogItemVariantMapping.findMany({
        where: { catalogItemId, validUntil: null, isMerchantConfirmed: true },
      });
      if (confirmed.length > 0) return confirmed;
      await tx.tikTokCatalogItemVariantMapping.updateMany({
        where: { catalogItemId, validUntil: null, isMerchantConfirmed: false },
        data: { validUntil: new Date() },
      });
      if (mappings.length === 0) return [];
      return Promise.all(
        mappings.map((mapping) =>
          tx.tikTokCatalogItemVariantMapping.create({
            data: { catalogItemId, ...mapping, isMerchantConfirmed: false },
          }),
        ),
      );
    });
  }

  async replaceAutomaticAdMappings(
    tiktokAdId: string,
    mappings: Array<{
      productId: string;
      variantId?: string | null;
      catalogItemId?: string | null;
      granularity: 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT';
      source: 'CATALOG_ITEM' | 'LANDING_PAGE' | 'CREATIVE_PRODUCT_DATA' | 'INFERRED';
      confidence: number;
      evidenceJson?: unknown;
      landingUrl?: string | null;
      providerProductId?: string | null;
      providerProductGroupId?: string | null;
    }>,
  ) {
    return prisma.$transaction(async (tx) => {
      const confirmed = await tx.tikTokAdProductMapping.findMany({
        where: { tiktokAdId, validUntil: null, isMerchantConfirmed: true },
      });
      if (confirmed.length > 0) return confirmed;
      await tx.tikTokAdProductMapping.updateMany({
        where: { tiktokAdId, validUntil: null, isMerchantConfirmed: false },
        data: { validUntil: new Date() },
      });
      if (mappings.length === 0) return [];
      return Promise.all(
        mappings.map((mapping) =>
          tx.tikTokAdProductMapping.create({
            data: {
              tiktokAdId,
              productId: mapping.productId,
              variantId: mapping.variantId ?? null,
              catalogItemId: mapping.catalogItemId ?? null,
              granularity: mapping.granularity,
              source: mapping.source,
              confidence: mapping.confidence,
              evidenceJson: optionalJson(mapping.evidenceJson),
              landingUrl: mapping.landingUrl ?? null,
              providerProductId: mapping.providerProductId ?? null,
              providerProductGroupId: mapping.providerProductGroupId ?? null,
              isMerchantConfirmed: false,
            },
          }),
        ),
      );
    });
  }

  async replaceManualAdMapping(storeId: string, externalAdId: string, productId: string, variantId: string | null) {
    const ad = await prisma.tikTokAd.findFirst({
      where: { tiktokAdId: externalAdId, advertiser: { storeId }, deletedAt: null },
      select: { id: true },
    });
    if (!ad) return null;
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: { id: true },
    });
    if (!product) return null;
    if (variantId) {
      const variant = await prisma.productVariant.findFirst({
        where: { id: variantId, storeId, productId, deletedAt: null },
        select: { id: true },
      });
      if (!variant) return null;
    }
    return prisma.$transaction(async (tx) => {
      await tx.tikTokAdProductMapping.updateMany({
        where: { tiktokAdId: ad.id, validUntil: null },
        data: { validUntil: new Date() },
      });
      return tx.tikTokAdProductMapping.create({
        data: {
          tiktokAdId: ad.id,
          productId,
          variantId,
          granularity: variantId ? 'VARIANT' : 'PRODUCT',
          source: 'MANUAL',
          confidence: 1,
          isMerchantConfirmed: true,
        },
      });
    });
  }

  async replaceManualCatalogMapping(storeId: string, catalogItemId: string, variantId: string) {
    const [item, variant] = await Promise.all([
      prisma.tikTokCatalogItem.findFirst({
        where: { id: catalogItemId, catalog: { storeId }, deletedAt: null },
        select: { id: true },
      }),
      prisma.productVariant.findFirst({
        where: { id: variantId, storeId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!item || !variant) return null;
    return prisma.$transaction(async (tx) => {
      await tx.tikTokCatalogItemVariantMapping.updateMany({
        where: { catalogItemId, validUntil: null },
        data: { validUntil: new Date() },
      });
      return tx.tikTokCatalogItemVariantMapping.create({
        data: {
          catalogItemId,
          variantId,
          source: 'MANUAL',
          confidence: 1,
          isMerchantConfirmed: true,
        },
      });
    });
  }
}
