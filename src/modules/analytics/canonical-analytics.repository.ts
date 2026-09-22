import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { AdvertisingAnalyticsRepository } from './advertising-analytics.repository.js';
import type { AnalyticsRepository } from './analytics.repository.js';

const PURCHASE_ACTION_TYPE = 'offsite_conversion.fb_pixel_purchase';

type JsonRecord = Record<string, unknown>;
type MetaRows = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>;
type CampaignPage = Awaited<ReturnType<AnalyticsRepository['getCampaignsPage']>>;
type Campaign = Awaited<ReturnType<AnalyticsRepository['getCampaign']>>;
type AdSetPage = Awaited<ReturnType<AnalyticsRepository['getAdSetsPage']>>;
type AdSet = Awaited<ReturnType<AnalyticsRepository['getAdSet']>>;
type AdPage = Awaited<ReturnType<AnalyticsRepository['getAdsPage']>>;
type Ad = Awaited<ReturnType<AnalyticsRepository['getAd']>>;
type CreativePage = Awaited<ReturnType<AnalyticsRepository['getCreativesPage']>>;
type Creative = Awaited<ReturnType<AnalyticsRepository['getCreative']>>;

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function jsonString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function jsonBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function jsonValue(value: unknown): Prisma.JsonValue | null {
  return value === undefined ? null : (value as Prisma.JsonValue);
}

function selectedAccounts(storeId: string, selectedAccountIds: string[]) {
  return {
    storeId,
    provider: 'META' as const,
    providerEntityId: { in: selectedAccountIds },
  };
}

/**
 * Meta-compatible application DTOs backed entirely by the canonical advertising hierarchy/facts.
 * This is composition rather than inheritance so Prisma client implementation types never leak
 * into the application repository contract.
 */
export class CanonicalAnalyticsRepository implements AdvertisingAnalyticsRepository {
  async getMetaRows(
    storeId: string,
    selectedAccountIds: string[],
    from: Date,
    to: Date,
    filter: {
      campaignIds?: string[];
      adSetIds?: string[];
      adIds?: string[];
      creativeIds?: string[];
    } = {},
  ): Promise<MetaRows> {
    if (selectedAccountIds.length === 0) return [] as MetaRows;
    const rows = await prisma.advertisingDailyMetric.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        account: selectedAccounts(storeId, selectedAccountIds),
        ...(filter.campaignIds ? { campaignId: { in: filter.campaignIds } } : {}),
        ...(filter.adSetIds ? { groupId: { in: filter.adSetIds } } : {}),
        ...(filter.adIds ? { adId: { in: filter.adIds } } : {}),
        ...(filter.creativeIds ? { creativeIdSnapshot: { in: filter.creativeIds } } : {}),
      },
      select: {
        date: true,
        currency: true,
        spend: true,
        impressions: true,
        clicks: true,
        frequency: true,
        conversions: true,
        conversionValue: true,
        syncedAt: true,
        providerMetrics: true,
        campaign: { select: { id: true, providerEntityId: true, name: true, objective: true } },
        group: {
          select: { id: true, providerEntityId: true, name: true, optimizationGoal: true },
        },
        ad: {
          select: {
            id: true,
            providerEntityId: true,
            name: true,
            creative: {
              select: { id: true, providerEntityId: true, name: true, title: true },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { adId: 'asc' }],
    });

    return rows.map((row) => {
      const provider = jsonRecord(row.providerMetrics);
      return {
        date: row.date,
        accountCurrency: row.currency ?? '',
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        frequency: row.frequency,
        objective: row.campaign?.objective ?? jsonString(provider.objective),
        optimizationGoal: row.group?.optimizationGoal ?? jsonString(provider.optimizationGoal),
        attributionSetting: jsonString(provider.attributionSetting),
        syncedAt: row.syncedAt,
        campaign: row.campaign
          ? {
              id: row.campaign.id,
              metaCampaignId: row.campaign.providerEntityId,
              name: row.campaign.name,
            }
          : null,
        adSet: row.group
          ? {
              id: row.group.id,
              metaAdSetId: row.group.providerEntityId,
              name: row.group.name,
            }
          : null,
        ad: row.ad
          ? {
              id: row.ad.id,
              metaAdId: row.ad.providerEntityId,
              name: row.ad.name,
              creative: row.ad.creative
                ? {
                    id: row.ad.creative.id,
                    metaCreativeId: row.ad.creative.providerEntityId,
                    name: row.ad.creative.name,
                    title: row.ad.creative.title,
                  }
                : null,
            }
          : null,
        actions: [
          {
            kind: 'ACTION' as const,
            actionType: PURCHASE_ACTION_TYPE,
            actionDestination: null,
            value: new Prisma.Decimal(row.conversions ?? 0),
          },
          {
            kind: 'ACTION_VALUE' as const,
            actionType: PURCHASE_ACTION_TYPE,
            actionDestination: null,
            value: new Prisma.Decimal(row.conversionValue ?? 0),
          },
        ],
      };
    }) as MetaRows;
  }

  async getCampaignsPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): Promise<CampaignPage> {
    const where = {
      deletedAt: null,
      account: selectedAccounts(storeId, selectedAccountIds),
    };
    const [total, rows] = await Promise.all([
      prisma.advertisingCampaign.count({ where }),
      prisma.advertisingCampaign.findMany({
        where,
        orderBy: [{ providerUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          providerEntityId: true,
          name: true,
          status: true,
          effectiveStatus: true,
          objective: true,
          campaignType: true,
          bidStrategy: true,
          startsAt: true,
          endsAt: true,
          providerData: true,
        },
      }),
    ]);
    const items = rows.map((row) => {
      const provider = jsonRecord(row.providerData);
      return {
        id: row.id,
        metaCampaignId: row.providerEntityId,
        name: row.name,
        effectiveStatus: row.effectiveStatus,
        configuredStatus: row.status,
        objective: row.objective,
        buyingType: row.campaignType,
        bidStrategy: row.bidStrategy,
        dailyBudgetMinor: jsonBigInt(provider.dailyBudgetMinor),
        lifetimeBudgetMinor: jsonBigInt(provider.lifetimeBudgetMinor),
        budgetRemainingMinor: jsonBigInt(provider.budgetRemainingMinor),
        startTime: row.startsAt,
        stopTime: row.endsAt,
      };
    });
    return { total, items } as CampaignPage;
  }

  async getCampaign(
    storeId: string,
    selectedAccountIds: string[],
    campaignId: string,
  ): Promise<Campaign> {
    const row = await prisma.advertisingCampaign.findFirst({
      where: {
        id: campaignId,
        deletedAt: null,
        account: selectedAccounts(storeId, selectedAccountIds),
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        status: true,
        effectiveStatus: true,
        objective: true,
        campaignType: true,
        bidStrategy: true,
        startsAt: true,
        endsAt: true,
        providerData: true,
      },
    });
    if (!row) return null;
    const provider = jsonRecord(row.providerData);
    return {
      id: row.id,
      metaCampaignId: row.providerEntityId,
      name: row.name,
      effectiveStatus: row.effectiveStatus,
      configuredStatus: row.status,
      objective: row.objective,
      buyingType: row.campaignType,
      bidStrategy: row.bidStrategy,
      dailyBudgetMinor: jsonBigInt(provider.dailyBudgetMinor),
      lifetimeBudgetMinor: jsonBigInt(provider.lifetimeBudgetMinor),
      budgetRemainingMinor: jsonBigInt(provider.budgetRemainingMinor),
      startTime: row.startsAt,
      stopTime: row.endsAt,
    } as Campaign;
  }

  async getAdSetsPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): Promise<AdSetPage> {
    const where = {
      deletedAt: null,
      kind: 'AD_SET' as const,
      account: selectedAccounts(storeId, selectedAccountIds),
    };
    const [total, rows] = await Promise.all([
      prisma.advertisingGroup.count({ where }),
      prisma.advertisingGroup.findMany({
        where,
        orderBy: [{ providerUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          providerEntityId: true,
          name: true,
          status: true,
          effectiveStatus: true,
          optimizationGoal: true,
          billingEvent: true,
          bidStrategy: true,
          startsAt: true,
          endsAt: true,
          providerData: true,
          campaign: { select: { id: true, providerEntityId: true, name: true } },
        },
      }),
    ]);
    const items = rows.map((row) => {
      const provider = jsonRecord(row.providerData);
      return {
        id: row.id,
        metaAdSetId: row.providerEntityId,
        name: row.name,
        effectiveStatus: row.effectiveStatus,
        configuredStatus: row.status,
        optimizationGoal: row.optimizationGoal,
        billingEvent: row.billingEvent,
        bidStrategy: row.bidStrategy,
        bidAmountMinor: jsonBigInt(provider.bidAmountMinor),
        dailyBudgetMinor: jsonBigInt(provider.dailyBudgetMinor),
        lifetimeBudgetMinor: jsonBigInt(provider.lifetimeBudgetMinor),
        budgetRemainingMinor: jsonBigInt(provider.budgetRemainingMinor),
        startTime: row.startsAt,
        endTime: row.endsAt,
        campaign: {
          id: row.campaign.id,
          name: row.campaign.name,
          metaCampaignId: row.campaign.providerEntityId,
        },
      };
    });
    return { total, items } as AdSetPage;
  }

  async getAdSet(
    storeId: string,
    selectedAccountIds: string[],
    adSetId: string,
  ): Promise<AdSet> {
    const row = await prisma.advertisingGroup.findFirst({
      where: {
        id: adSetId,
        deletedAt: null,
        kind: 'AD_SET',
        account: selectedAccounts(storeId, selectedAccountIds),
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        status: true,
        effectiveStatus: true,
        optimizationGoal: true,
        billingEvent: true,
        bidStrategy: true,
        targeting: true,
        startsAt: true,
        endsAt: true,
        providerData: true,
        campaign: { select: { id: true, providerEntityId: true, name: true } },
      },
    });
    if (!row) return null;
    const provider = jsonRecord(row.providerData);
    return {
      id: row.id,
      metaAdSetId: row.providerEntityId,
      name: row.name,
      effectiveStatus: row.effectiveStatus,
      configuredStatus: row.status,
      optimizationGoal: row.optimizationGoal,
      billingEvent: row.billingEvent,
      bidStrategy: row.bidStrategy,
      bidAmountMinor: jsonBigInt(provider.bidAmountMinor),
      dailyBudgetMinor: jsonBigInt(provider.dailyBudgetMinor),
      lifetimeBudgetMinor: jsonBigInt(provider.lifetimeBudgetMinor),
      budgetRemainingMinor: jsonBigInt(provider.budgetRemainingMinor),
      targeting: row.targeting,
      attributionSpec: jsonValue(provider.attributionSpec),
      startTime: row.startsAt,
      endTime: row.endsAt,
      campaign: {
        id: row.campaign.id,
        name: row.campaign.name,
        metaCampaignId: row.campaign.providerEntityId,
      },
    } as AdSet;
  }

  async getAdsPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): Promise<AdPage> {
    const where = {
      deletedAt: null,
      groupId: { not: null as string | null },
      account: selectedAccounts(storeId, selectedAccountIds),
    };
    const rows = await prisma.advertisingAd.findMany({
      where,
      orderBy: [{ providerUpdatedAt: 'desc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        status: true,
        effectiveStatus: true,
        campaign: { select: { id: true, providerEntityId: true, name: true } },
        group: { select: { id: true, providerEntityId: true, name: true } },
        creative: {
          select: {
            id: true,
            providerEntityId: true,
            name: true,
            title: true,
            thumbnailUrl: true,
          },
        },
      },
    });
    const items = rows.flatMap((row) =>
      row.group
        ? [{
            id: row.id,
            metaAdId: row.providerEntityId,
            name: row.name,
            effectiveStatus: row.effectiveStatus,
            configuredStatus: row.status,
            campaign: {
              id: row.campaign.id,
              name: row.campaign.name,
              metaCampaignId: row.campaign.providerEntityId,
            },
            adSet: {
              id: row.group.id,
              name: row.group.name,
              metaAdSetId: row.group.providerEntityId,
            },
            creative: row.creative
              ? {
                  id: row.creative.id,
                  metaCreativeId: row.creative.providerEntityId,
                  name: row.creative.name,
                  title: row.creative.title,
                  thumbnailUrl: row.creative.thumbnailUrl,
                }
              : null,
          }]
        : [],
    );
    const total = await prisma.advertisingAd.count({ where });
    return { total, items } as AdPage;
  }

  async getAd(storeId: string, selectedAccountIds: string[], adId: string): Promise<Ad> {
    const row = await prisma.advertisingAd.findFirst({
      where: {
        id: adId,
        deletedAt: null,
        groupId: { not: null },
        account: selectedAccounts(storeId, selectedAccountIds),
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        status: true,
        effectiveStatus: true,
        targetScope: true,
        targetScopeConfidence: true,
        providerData: true,
        campaign: { select: { id: true, providerEntityId: true, name: true } },
        group: { select: { id: true, providerEntityId: true, name: true } },
        creative: {
          select: {
            id: true,
            providerEntityId: true,
            name: true,
            title: true,
            body: true,
            callToActionType: true,
            imageUrl: true,
            thumbnailUrl: true,
            videoId: true,
            linkUrl: true,
            providerData: true,
          },
        },
      },
    });
    if (!row?.group) return null;
    const provider = jsonRecord(row.providerData);
    const creativeProvider = jsonRecord(row.creative?.providerData);
    return {
      id: row.id,
      metaAdId: row.providerEntityId,
      name: row.name,
      effectiveStatus: row.effectiveStatus,
      configuredStatus: row.status,
      conversionDomain: jsonString(provider.conversionDomain),
      targetScope: row.targetScope as Ad extends null ? never : NonNullable<Ad>['targetScope'],
      targetScopeConfidence: row.targetScopeConfidence,
      campaign: {
        id: row.campaign.id,
        name: row.campaign.name,
        metaCampaignId: row.campaign.providerEntityId,
      },
      adSet: {
        id: row.group.id,
        name: row.group.name,
        metaAdSetId: row.group.providerEntityId,
      },
      creative: row.creative
        ? {
            id: row.creative.id,
            metaCreativeId: row.creative.providerEntityId,
            name: row.creative.name,
            title: row.creative.title,
            body: row.creative.body,
            callToActionType: row.creative.callToActionType,
            imageUrl: row.creative.imageUrl,
            thumbnailUrl: row.creative.thumbnailUrl,
            videoId: row.creative.videoId,
            linkUrl: row.creative.linkUrl,
            instagramPermalinkUrl: jsonString(creativeProvider.instagramPermalinkUrl),
          }
        : null,
    } as Ad;
  }

  async getCreativesPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): Promise<CreativePage> {
    const where = {
      deletedAt: null,
      account: selectedAccounts(storeId, selectedAccountIds),
    };
    const [total, rows] = await Promise.all([
      prisma.advertisingCreative.count({ where }),
      prisma.advertisingCreative.findMany({
        where,
        orderBy: [{ providerUpdatedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          providerEntityId: true,
          name: true,
          title: true,
          body: true,
          callToActionType: true,
          imageUrl: true,
          thumbnailUrl: true,
          videoId: true,
          linkUrl: true,
        },
      }),
    ]);
    const items = rows.map((row) => ({
      id: row.id,
      metaCreativeId: row.providerEntityId,
      name: row.name,
      title: row.title,
      body: row.body,
      callToActionType: row.callToActionType,
      imageUrl: row.imageUrl,
      thumbnailUrl: row.thumbnailUrl,
      videoId: row.videoId,
      linkUrl: row.linkUrl,
    }));
    return { total, items } as CreativePage;
  }

  async getCreative(
    storeId: string,
    selectedAccountIds: string[],
    creativeId: string,
  ): Promise<Creative> {
    const row = await prisma.advertisingCreative.findFirst({
      where: {
        id: creativeId,
        deletedAt: null,
        account: selectedAccounts(storeId, selectedAccountIds),
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        title: true,
        body: true,
        callToActionType: true,
        imageUrl: true,
        thumbnailUrl: true,
        videoId: true,
        linkUrl: true,
        providerData: true,
      },
    });
    if (!row) return null;
    const provider = jsonRecord(row.providerData);
    return {
      id: row.id,
      metaCreativeId: row.providerEntityId,
      name: row.name,
      title: row.title,
      body: row.body,
      callToActionType: row.callToActionType,
      imageUrl: row.imageUrl,
      thumbnailUrl: row.thumbnailUrl,
      videoId: row.videoId,
      linkUrl: row.linkUrl,
      instagramPermalinkUrl: jsonString(provider.instagramPermalinkUrl),
      urlTags: jsonString(provider.urlTags),
    } as Creative;
  }
}
