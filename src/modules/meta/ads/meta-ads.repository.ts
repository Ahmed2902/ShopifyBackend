import { Prisma } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import {
  enqueueMetaHierarchyPixelRepairs,
  type MetaHierarchyRepairEvidence,
} from '../../pixel/pixel-source-invalidation.js';
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
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function creativeDestinationUrls(creative: MetaCreativePayload): string[] {
  const values = [
    creative.link_url,
    creative.link_deep_link_url,
    creative.object_url,
    creative.template_url,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(values)];
}

export class MetaAdsRepository {
  // Provider refreshes update many presentation/performance fields that do not participate in Pixel
  // hierarchy resolution. Keep the provider upsert atomic with repair enqueueing, but only enqueue
  // when resolver truth actually changes: a row appears/reappears or a parent relationship changes.
  // This makes the hierarchy refresh performed before Insights sync safe without rematerializing
  // unaffected storefront sessions on every ordinary Meta refresh.
  private mutateHierarchy<TCurrent, TResult>(
    adAccountId: string,
    evidence: MetaHierarchyRepairEvidence,
    readCurrent: (tx: Prisma.TransactionClient) => Promise<TCurrent | null>,
    resolverTruthChanged: (current: TCurrent | null) => boolean,
    mutate: (tx: Prisma.TransactionClient) => Promise<TResult>,
  ): Promise<TResult> {
    return prisma.$transaction(async (tx) => {
      const current = await readCurrent(tx);
      const result = await mutate(tx);
      if (!resolverTruthChanged(current)) return result;

      const account = await tx.metaAdAccount.findUniqueOrThrow({
        where: { id: adAccountId },
        select: { storeId: true },
      });
      await enqueueMetaHierarchyPixelRepairs(account.storeId, tx, evidence);
      return result;
    });
  }

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
    const key = { adAccountId_metaCampaignId: { adAccountId, metaCampaignId: campaign.id } };

    return this.mutateHierarchy(
      adAccountId,
      { campaignIds: [campaign.id] },
      (tx) => tx.metaCampaign.findUnique({ where: key, select: { deletedAt: true } }),
      (current) => current === null || current.deletedAt !== null,
      (tx) => tx.metaCampaign.upsert({
        where: key,
        create: { adAccountId, metaCampaignId: campaign.id, ...data },
        update: data,
        select: { id: true, metaCampaignId: true },
      }),
    );
  }

  upsertAdSet(adAccountId: string, campaignId: string, adSet: MetaAdSetPayload) {
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
    const key = { adAccountId_metaAdSetId: { adAccountId, metaAdSetId: adSet.id } };

    return this.mutateHierarchy(
      adAccountId,
      { adSetIds: [adSet.id] },
      (tx) => tx.metaAdSet.findUnique({
        where: key,
        select: { campaignId: true, deletedAt: true },
      }),
      (current) =>
        current === null || current.deletedAt !== null || current.campaignId !== campaignId,
      (tx) => tx.metaAdSet.upsert({
        where: key,
        create: { adAccountId, metaAdSetId: adSet.id, ...data },
        update: data,
        select: { id: true, metaAdSetId: true },
      }),
    );
  }

  upsertCreative(adAccountId: string, creative: MetaCreativePayload) {
    const data = {
      name: creative.name ?? null,
      title: creative.title ?? null,
      body: creative.body ?? null,
      callToAction: nullableJson(creative.call_to_action),
      callToActionType: creative.call_to_action_type ?? null,
      imageUrl: creative.image_url ?? null,
      thumbnailUrl: creative.thumbnail_url ?? null,
      videoId: creative.video_id ?? null,
      linkUrl: creative.link_url ?? null,
      linkDeepLinkUrl: creative.link_deep_link_url ?? null,
      objectUrl: creative.object_url ?? null,
      objectStoryId: creative.object_story_id ?? null,
      effectiveObjectStoryId: creative.effective_object_story_id ?? null,
      effectiveInstagramMediaId: creative.effective_instagram_media_id ?? null,
      instagramPermalinkUrl: creative.instagram_permalink_url ?? null,
      objectStorySpec: nullableJson(creative.object_story_spec),
      productSetId: creative.product_set_id ?? null,
      productData: nullableJson(creative.product_data),
      assetFeedSpec: nullableJson(creative.asset_feed_spec),
      degreesOfFreedomSpec: nullableJson(creative.degrees_of_freedom_spec),
      resolvedDestinationUrls: nullableJson(creativeDestinationUrls(creative)),
      templateUrl: creative.template_url ?? null,
      templateUrlSpec: nullableJson(creative.template_url_spec),
      urlTags: creative.url_tags ?? null,
      metaCreatedAt: optionalDate(creative.created_time),
      metaUpdatedAt: optionalDate(creative.updated_time),
      deletedAt: null,
      rawJson: creative as unknown as Prisma.InputJsonValue,
    };

    // Pixel hierarchy resolution stores campaign/ad-set/ad identity only; creative metadata changes
    // do not alter a materialized touch's EXACT/PARTIAL/UNRESOLVED/CONFLICT result.
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
    const providerData = {
      campaignId,
      adSetId,
      creativeId,
      name: ad.name,
      configuredStatus: ad.configured_status ?? ad.status ?? null,
      effectiveStatus: ad.effective_status ?? null,
      conversionDomain: ad.conversion_domain ?? null,
      sourceAdId: ad.source_ad_id ?? null,
      placement: nullableJson(ad.placement),
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
    const key = { adAccountId_metaAdId: { adAccountId, metaAdId: ad.id } };

    return this.mutateHierarchy(
      adAccountId,
      { adIds: [ad.id] },
      (tx) => tx.metaAd.findUnique({
        where: key,
        select: { campaignId: true, adSetId: true, deletedAt: true },
      }),
      (current) =>
        current === null ||
        current.deletedAt !== null ||
        current.campaignId !== campaignId ||
        current.adSetId !== adSetId,
      (tx) => tx.metaAd.upsert({
        where: key,
        create: {
          adAccountId,
          metaAdId: ad.id,
          targetScope: 'UNKNOWN',
          targetScopeConfidence: null,
          targetScopeEvidence: Prisma.DbNull,
          ...providerData,
        },
        update: providerData,
        select: { id: true, metaAdId: true },
      }),
    );
  }

  async softDeleteMissing(
    adAccountId: string,
    snapshot: { campaignIds: string[]; adSetIds: string[]; creativeIds: string[]; adIds: string[] },
  ) {
    return prisma.$transaction(async (tx) => {
      const account = await tx.metaAdAccount.findUniqueOrThrow({
        where: { id: adAccountId },
        select: { storeId: true },
      });
      const now = new Date();
      const [missingCampaigns, missingAdSets, missingAds] = await Promise.all([
        tx.metaCampaign.findMany({
          where: { adAccountId, deletedAt: null, metaCampaignId: { notIn: snapshot.campaignIds } },
          select: { metaCampaignId: true },
        }),
        tx.metaAdSet.findMany({
          where: { adAccountId, deletedAt: null, metaAdSetId: { notIn: snapshot.adSetIds } },
          select: { metaAdSetId: true },
        }),
        tx.metaAd.findMany({
          where: { adAccountId, deletedAt: null, metaAdId: { notIn: snapshot.adIds } },
          select: { metaAdId: true },
        }),
      ]);
      const [campaigns, adSets, creatives, ads] = await Promise.all([
        tx.metaCampaign.updateMany({
          where: { adAccountId, deletedAt: null, metaCampaignId: { notIn: snapshot.campaignIds } },
          data: { deletedAt: now },
        }),
        tx.metaAdSet.updateMany({
          where: { adAccountId, deletedAt: null, metaAdSetId: { notIn: snapshot.adSetIds } },
          data: { deletedAt: now },
        }),
        tx.metaCreative.updateMany({
          where: { adAccountId, deletedAt: null, metaCreativeId: { notIn: snapshot.creativeIds } },
          data: { deletedAt: now },
        }),
        tx.metaAd.updateMany({
          where: { adAccountId, deletedAt: null, metaAdId: { notIn: snapshot.adIds } },
          data: { deletedAt: now },
        }),
      ]);

      await enqueueMetaHierarchyPixelRepairs(account.storeId, tx, {
        campaignIds: missingCampaigns.map((row) => row.metaCampaignId),
        adSetIds: missingAdSets.map((row) => row.metaAdSetId),
        adIds: missingAds.map((row) => row.metaAdId),
      });

      return {
        campaigns: campaigns.count,
        adSets: adSets.count,
        creatives: creatives.count,
        ads: ads.count,
      };
    });
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

  private async selectedAccountIds(storeId: string): Promise<string[]> {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    return connection?.selectedAdAccountIds ?? [];
  }

  async listAdAccounts(storeId: string) {
    const selectedIds = await this.selectedAccountIds(storeId);
    if (selectedIds.length === 0) return [];
    return prisma.metaAdAccount.findMany({
      where: { storeId, metaAccountId: { in: selectedIds } },
      select: {
        metaAccountId: true,
        name: true,
        status: true,
        currency: true,
        timezoneName: true,
        timezoneId: true,
        timezoneOffsetHours: true,
        amountSpentMinor: true,
        balanceMinor: true,
        spendCapMinor: true,
        lastSyncedAt: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async listCampaigns(
    storeId: string,
    input: { adAccountId?: string; status?: string; page: number; limit: number },
  ) {
    const selectedIds = await this.selectedAccountIds(storeId);
    if (selectedIds.length === 0) return { items: [], total: 0 };
    const where = {
      adAccount: {
        storeId,
        metaAccountId: { in: selectedIds },
        ...(input.adAccountId ? { metaAccountId: input.adAccountId } : {}),
      },
      deletedAt: null,
      ...(input.status ? { effectiveStatus: input.status } : {}),
    } satisfies Prisma.MetaCampaignWhereInput;
    const [items, total] = await prisma.$transaction([
      prisma.metaCampaign.findMany({
        where,
        select: {
          metaCampaignId: true,
          name: true,
          status: true,
          configuredStatus: true,
          effectiveStatus: true,
          objective: true,
          buyingType: true,
          bidStrategy: true,
          dailyBudgetMinor: true,
          lifetimeBudgetMinor: true,
          budgetRemainingMinor: true,
          spendCapMinor: true,
          startTime: true,
          stopTime: true,
          promotedObject: true,
          metaCreatedAt: true,
          metaUpdatedAt: true,
          adAccount: { select: { metaAccountId: true, name: true, currency: true } },
        },
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.metaCampaign.count({ where }),
    ]);
    return { items, total };
  }

  async listAdSets(
    storeId: string,
    input: { campaignId?: string; status?: string; page: number; limit: number },
  ) {
    const selectedIds = await this.selectedAccountIds(storeId);
    if (selectedIds.length === 0) return { items: [], total: 0 };
    const where = {
      adAccount: { storeId, metaAccountId: { in: selectedIds } },
      deletedAt: null,
      ...(input.campaignId ? { campaign: { metaCampaignId: input.campaignId } } : {}),
      ...(input.status ? { effectiveStatus: input.status } : {}),
    } satisfies Prisma.MetaAdSetWhereInput;
    const [items, total] = await prisma.$transaction([
      prisma.metaAdSet.findMany({
        where,
        select: {
          metaAdSetId: true,
          name: true,
          status: true,
          configuredStatus: true,
          effectiveStatus: true,
          dailyBudgetMinor: true,
          lifetimeBudgetMinor: true,
          budgetRemainingMinor: true,
          dailySpendCapMinor: true,
          lifetimeSpendCapMinor: true,
          bidStrategy: true,
          bidAmountMinor: true,
          bidConstraints: true,
          billingEvent: true,
          optimizationGoal: true,
          destinationType: true,
          isDynamicCreative: true,
          targeting: true,
          promotedObject: true,
          attributionSpec: true,
          startTime: true,
          endTime: true,
          learningStageInfo: true,
          metaCreatedAt: true,
          metaUpdatedAt: true,
          campaign: { select: { metaCampaignId: true, name: true } },
          adAccount: { select: { metaAccountId: true, name: true, currency: true } },
        },
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.metaAdSet.count({ where }),
    ]);
    return { items, total };
  }

  async listAds(
    storeId: string,
    input: { campaignId?: string; adSetId?: string; status?: string; page: number; limit: number },
  ) {
    const selectedIds = await this.selectedAccountIds(storeId);
    if (selectedIds.length === 0) return { items: [], total: 0 };
    const where = {
      adAccount: { storeId, metaAccountId: { in: selectedIds } },
      deletedAt: null,
      ...(input.campaignId ? { campaign: { metaCampaignId: input.campaignId } } : {}),
      ...(input.adSetId ? { adSet: { metaAdSetId: input.adSetId } } : {}),
      ...(input.status ? { effectiveStatus: input.status } : {}),
    } satisfies Prisma.MetaAdWhereInput;
    const [items, total] = await prisma.$transaction([
      prisma.metaAd.findMany({
        where,
        select: {
          metaAdId: true,
          name: true,
          configuredStatus: true,
          effectiveStatus: true,
          conversionDomain: true,
          sourceAdId: true,
          targetScope: true,
          targetScopeConfidence: true,
          targetScopeEvidence: true,
          placement: true,
          recommendations: true,
          issuesInfo: true,
          metaCreatedAt: true,
          metaUpdatedAt: true,
          campaign: { select: { metaCampaignId: true, name: true } },
          adSet: { select: { metaAdSetId: true, name: true, learningStageInfo: true } },
          creative: {
            select: {
              metaCreativeId: true,
              name: true,
              title: true,
              body: true,
              callToActionType: true,
              imageUrl: true,
              thumbnailUrl: true,
              videoId: true,
              linkUrl: true,
              linkDeepLinkUrl: true,
              objectUrl: true,
              productSetId: true,
              productData: true,
              resolvedDestinationUrls: true,
              templateUrl: true,
              urlTags: true,
            },
          },
          adAccount: { select: { metaAccountId: true, name: true, currency: true } },
        },
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.metaAd.count({ where }),
    ]);
    return { items, total };
  }

  async getAd(storeId: string, metaAdId: string) {
    const selectedIds = await this.selectedAccountIds(storeId);
    if (selectedIds.length === 0) return null;
    return prisma.metaAd.findFirst({
      where: {
        metaAdId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedIds } },
      },
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
