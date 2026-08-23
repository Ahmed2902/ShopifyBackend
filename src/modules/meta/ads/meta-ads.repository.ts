import { Prisma, type MetaAdTargetScope } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { parseMetaMinorAmount } from '../meta.utils.js';
import type {
  MetaAdPayload,
  MetaAdSetPayload,
  MetaCampaignPayload,
  MetaCreativePayload,
} from './meta-ads.schema.js';

function optionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('Meta returned an invalid datetime', 502, 'META_BAD_RESPONSE');
  }
  return date;
}

function nullableJson(value: unknown) {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

export class MetaAdsRepository {
  findAccount(storeId: string, connectionId: string, metaAccountId: string) {
    return prisma.metaAdAccount.findFirst({
      where: { storeId, metaConnectionId: connectionId, metaAccountId },
      select: { id: true, metaAccountId: true, currency: true },
    });
  }

  updateAccountProfile(
    accountId: string,
    input: {
      name: string;
      status: number | null;
      currency: string;
      timezoneName: string | null;
      timezoneId: number | null;
      timezoneOffsetHours: number | null;
      amountSpentMinor: bigint | null;
      balanceMinor: bigint | null;
      spendCapMinor: bigint | null;
      rawJson: unknown;
    },
  ) {
    return prisma.metaAdAccount.update({
      where: { id: accountId },
      data: {
        name: input.name,
        status: input.status === null ? null : String(input.status),
        currency: input.currency,
        timezoneName: input.timezoneName,
        timezoneId: input.timezoneId,
        timezoneOffsetHours: input.timezoneOffsetHours,
        amountSpentMinor: input.amountSpentMinor,
        balanceMinor: input.balanceMinor,
        spendCapMinor: input.spendCapMinor,
        rawJson: input.rawJson as Prisma.InputJsonValue,
      },
    });
  }

  upsertCampaign(adAccountId: string, campaign: MetaCampaignPayload) {
    const data = {
      name: campaign.name,
      status: campaign.status ?? null,
      configuredStatus: campaign.configured_status ?? campaign.status ?? null,
      effectiveStatus: campaign.effective_status ?? null,
      objective: campaign.objective ?? null,
      buyingType: campaign.buying_type ?? null,
      bidStrategy: campaign.bid_strategy ?? null,
      dailyBudgetMinor: parseMetaMinorAmount(campaign.daily_budget),
      lifetimeBudgetMinor: parseMetaMinorAmount(campaign.lifetime_budget),
      budgetRemainingMinor: parseMetaMinorAmount(campaign.budget_remaining),
      spendCapMinor: parseMetaMinorAmount(campaign.spend_cap),
      startTime: optionalDate(campaign.start_time),
      stopTime: optionalDate(campaign.stop_time),
      promotedObject: nullableJson(campaign.promoted_object),
      metaCreatedAt: optionalDate(campaign.created_time),
      metaUpdatedAt: optionalDate(campaign.updated_time),
      deletedAt: null,
      rawJson: campaign as unknown as Prisma.InputJsonValue,
    };

    return prisma.metaCampaign.upsert({
      where: { adAccountId_metaCampaignId: { adAccountId, metaCampaignId: campaign.id } },
      create: { adAccountId, metaCampaignId: campaign.id, ...data },
      update: data,
      select: { id: true, metaCampaignId: true },
    });
  }

  upsertAdSet(
    adAccountId: string,
    campaignId: string,
    adSet: MetaAdSetPayload,
  ) {
    const data = {
      campaignId,
      name: adSet.name,
      status: adSet.status ?? null,
      configuredStatus: adSet.configured_status ?? adSet.status ?? null,
      effectiveStatus: adSet.effective_status ?? null,
      dailyBudgetMinor: parseMetaMinorAmount(adSet.daily_budget),
      lifetimeBudgetMinor: parseMetaMinorAmount(adSet.lifetime_budget),
      budgetRemainingMinor: parseMetaMinorAmount(adSet.budget_remaining),
      dailySpendCapMinor: parseMetaMinorAmount(adSet.daily_spend_cap),
      lifetimeSpendCapMinor: parseMetaMinorAmount(adSet.lifetime_spend_cap),
      bidStrategy: adSet.bid_strategy ?? null,
      bidAmountMinor: parseMetaMinorAmount(adSet.bid_amount),
      bidConstraints: nullableJson(adSet.bid_constraints),
      billingEvent: adSet.billing_event ?? null,
      optimizationGoal: adSet.optimization_goal ?? null,
      destinationType: adSet.destination_type ?? null,
      isDynamicCreative: adSet.is_dynamic_creative ?? null,
      targeting: nullableJson(adSet.targeting),
      promotedObject: nullableJson(adSet.promoted_object),
      attributionSpec: nullableJson(adSet.attribution_spec),
      startTime: optionalDate(adSet.start_time),
      endTime: optionalDate(adSet.end_time),
      learningStageInfo: nullableJson(adSet.learning_stage_info),
      metaCreatedAt: optionalDate(adSet.created_time),
      metaUpdatedAt: optionalDate(adSet.updated_time),
      deletedAt: null,
      rawJson: adSet as unknown as Prisma.InputJsonValue,
    };

    return prisma.metaAdSet.upsert({
      where: { adAccountId_metaAdSetId: { adAccountId, metaAdSetId: adSet.id } },
      create: { adAccountId, metaAdSetId: adSet.id, ...data },
      update: data,
      select: { id: true, metaAdSetId: true },
    });
  }

  upsertCreative(adAccountId: string, creative: MetaCreativePayload) {
    const storySpec = creative.object_story_spec;
    const assetFeedSpec = creative.asset_feed_spec;
    const data = {
      name: creative.name ?? null,
      title: creative.title ?? null,
      body: creative.body ?? null,
      callToActionType: creative.call_to_action_type ?? null,
      imageUrl: creative.image_url ?? null,
      thumbnailUrl: creative.thumbnail_url ?? null,
      effectiveObjectStoryId: creative.effective_object_story_id ?? null,
      effectiveInstagramMediaId: creative.effective_instagram_media_id ?? null,
      instagramPermalinkUrl: creative.instagram_permalink_url ?? null,
      objectStorySpec: nullableJson(storySpec),
      productSetId: creative.product_set_id ?? null,
      assetFeedSpec: nullableJson(assetFeedSpec),
      degreesOfFreedomSpec: nullableJson(creative.degrees_of_freedom_spec),
      templateUrl: creative.template_url ?? null,
      urlTags: creative.url_tags ?? null,
      deletedAt: null,
      rawJson: creative as unknown as Prisma.InputJsonValue,
    };

    return prisma.metaCreative.upsert({
      where: { adAccountId_metaCreativeId: { adAccountId, metaCreativeId: creative.id } },
      create: { adAccountId, metaCreativeId: creative.id, ...data },
      update: data,
      select: { id: true, metaCreativeId: true },
    });
  }

  upsertAd(
    adAccountId: string,
    campaignId: string,
    adSetId: string,
    creativeId: string | null,
    ad: MetaAdPayload,
  ) {
    const targetScope: MetaAdTargetScope = 'UNKNOWN';
    const data = {
      campaignId,
      adSetId,
      creativeId,
      name: ad.name,
      configuredStatus: ad.configured_status ?? ad.status ?? null,
      effectiveStatus: ad.effective_status ?? null,
      conversionDomain: ad.conversion_domain ?? null,
      sourceAdId: ad.source_ad_id ?? null,
      targetScope,
      placement: Prisma.DbNull,
      trackingSpec: nullableJson(ad.tracking_specs),
      conversionSpec: nullableJson(ad.conversion_specs),
      recommendations: nullableJson(ad.recommendations),
      issuesInfo: nullableJson(ad.issues_info),
      adLabels: nullableJson(ad.adlabels),
      metaCreatedAt: optionalDate(ad.created_time),
      metaUpdatedAt: optionalDate(ad.updated_time),
      deletedAt: null,
      rawJson: ad as unknown as Prisma.InputJsonValue,
    };

    return prisma.metaAd.upsert({
      where: { adAccountId_metaAdId: { adAccountId, metaAdId: ad.id } },
      create: { adAccountId, metaAdId: ad.id, ...data },
      update: data,
      select: { id: true, metaAdId: true },
    });
  }

  async softDeleteMissing(
    adAccountId: string,
    snapshot: {
      campaignIds: string[];
      adSetIds: string[];
      creativeIds: string[];
      adIds: string[];
    },
  ) {
    const now = new Date();
    const [campaigns, adSets, creatives, ads] = await prisma.$transaction([
      prisma.metaCampaign.updateMany({
        where: {
          adAccountId,
          deletedAt: null,
          ...(snapshot.campaignIds.length > 0
            ? { metaCampaignId: { notIn: snapshot.campaignIds } }
            : {}),
        },
        data: { deletedAt: now },
      }),
      prisma.metaAdSet.updateMany({
        where: {
          adAccountId,
          deletedAt: null,
          ...(snapshot.adSetIds.length > 0 ? { metaAdSetId: { notIn: snapshot.adSetIds } } : {}),
        },
        data: { deletedAt: now },
      }),
      prisma.metaCreative.updateMany({
        where: {
          adAccountId,
          deletedAt: null,
          ...(snapshot.creativeIds.length > 0
            ? { metaCreativeId: { notIn: snapshot.creativeIds } }
            : {}),
        },
        data: { deletedAt: now },
      }),
      prisma.metaAd.updateMany({
        where: {
          adAccountId,
          deletedAt: null,
          ...(snapshot.adIds.length > 0 ? { metaAdId: { notIn: snapshot.adIds } } : {}),
        },
        data: { deletedAt: now },
      }),
    ]);

    return {
      campaigns: campaigns.count,
      adSets: adSets.count,
      creatives: creatives.count,
      ads: ads.count,
    };
  }

  markAccountSynced(accountId: string, syncedAt = new Date()) {
    return prisma.metaAdAccount.update({
      where: { id: accountId },
      data: { lastSyncedAt: syncedAt },
    });
  }

  markConnectionSynced(connectionId: string, syncedAt = new Date()) {
    return prisma.metaConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: syncedAt },
    });
  }

  listAdAccounts(storeId: string) {
    return prisma.metaAdAccount.findMany({
      where: {
        storeId,
        connection: { selectedAdAccountIds: { has: prisma.metaAdAccount.fields.metaAccountId } },
      },
      orderBy: { name: 'asc' },
    });
  }

  listCampaigns(storeId: string, input: { adAccountId?: string; status?: string; take: number }) {
    return prisma.metaCampaign.findMany({
      where: {
        adAccount: {
          storeId,
          ...(input.adAccountId ? { metaAccountId: input.adAccountId } : {}),
        },
        deletedAt: null,
        ...(input.status ? { effectiveStatus: input.status } : {}),
      },
      include: { adAccount: { select: { metaAccountId: true, name: true, currency: true } } },
      orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
      take: input.take,
    });
  }

  listAdSets(storeId: string, input: { campaignId?: string; status?: string; take: number }) {
    return prisma.metaAdSet.findMany({
      where: {
        adAccount: { storeId },
        deletedAt: null,
        ...(input.campaignId ? { campaign: { metaCampaignId: input.campaignId } } : {}),
        ...(input.status ? { effectiveStatus: input.status } : {}),
      },
      include: {
        campaign: { select: { metaCampaignId: true, name: true } },
        adAccount: { select: { metaAccountId: true, name: true, currency: true } },
      },
      orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
      take: input.take,
    });
  }

  listAds(
    storeId: string,
    input: { campaignId?: string; adSetId?: string; status?: string; take: number },
  ) {
    return prisma.metaAd.findMany({
      where: {
        adAccount: { storeId },
        deletedAt: null,
        ...(input.campaignId ? { campaign: { metaCampaignId: input.campaignId } } : {}),
        ...(input.adSetId ? { adSet: { metaAdSetId: input.adSetId } } : {}),
        ...(input.status ? { effectiveStatus: input.status } : {}),
      },
      include: {
        campaign: { select: { metaCampaignId: true, name: true } },
        adSet: { select: { metaAdSetId: true, name: true } },
        creative: true,
        adAccount: { select: { metaAccountId: true, name: true, currency: true } },
      },
      orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
      take: input.take,
    });
  }

  getAd(storeId: string, metaAdId: string) {
    return prisma.metaAd.findFirst({
      where: { metaAdId, deletedAt: null, adAccount: { storeId } },
      include: {
        campaign: true,
        adSet: true,
        creative: true,
        adAccount: true,
        productMappings: {
          where: { validUntil: null },
          include: { product: true, variant: true, catalogItem: true },
        },
      },
    });
  }
}
