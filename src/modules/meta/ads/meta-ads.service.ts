import { AppError } from '../../../errors/app-error.js';
import type { MetaApiContext } from '../meta.types.js';
import type { MetaApiService } from '../shared/meta-api.service.js';
import type { MetaAdsRepository } from './meta-ads.repository.js';
import {
  metaAdSchema,
  metaAdSetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
  type MetaAdPayload,
  type MetaAdSetPayload,
  type MetaCampaignPayload,
  type MetaCreativePayload,
} from './meta-ads.schema.js';

const PAGE_SIZE = '100';

const CAMPAIGN_FIELDS = [
  'id',
  'name',
  'status',
  'configured_status',
  'effective_status',
  'objective',
  'buying_type',
  'bid_strategy',
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
  'spend_cap',
  'start_time',
  'stop_time',
  'promoted_object',
  'created_time',
  'updated_time',
].join(',');

const ADSET_FIELDS = [
  'id',
  'campaign_id',
  'name',
  'status',
  'configured_status',
  'effective_status',
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
  'daily_spend_cap',
  'lifetime_spend_cap',
  'bid_strategy',
  'bid_amount',
  'bid_constraints',
  'billing_event',
  'optimization_goal',
  'destination_type',
  'is_dynamic_creative',
  'targeting',
  'promoted_object',
  'attribution_spec',
  'start_time',
  'end_time',
  'learning_stage_info',
  'created_time',
  'updated_time',
].join(',');

const CREATIVE_FIELDS = [
  'id',
  'name',
  'title',
  'body',
  'call_to_action_type',
  'image_url',
  'thumbnail_url',
  'effective_object_story_id',
  'effective_instagram_media_id',
  'instagram_permalink_url',
  'object_story_spec',
  'asset_feed_spec',
  'degrees_of_freedom_spec',
  'product_set_id',
  'template_url',
  'url_tags',
].join(',');

const AD_FIELDS = [
  'id',
  'campaign_id',
  'adset_id',
  'name',
  'status',
  'configured_status',
  'effective_status',
  'conversion_domain',
  'source_ad_id',
  'creative{id}',
  'tracking_specs',
  'conversion_specs',
  'recommendations',
  'issues_info',
  'adlabels',
  'created_time',
  'updated_time',
].join(',');

function parseOrThrow<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  resource: string,
): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      `Meta ${resource} collection returned an unexpected record`,
      502,
      'META_BAD_RESPONSE',
    );
  }
  return parsed.data;
}

export interface MetaAdsHierarchySyncResult {
  recordsRead: number;
  recordsWritten: number;
  breakdown: {
    adAccounts: number;
    campaigns: number;
    adSets: number;
    creatives: number;
    ads: number;
    softDeletedCampaigns: number;
    softDeletedAdSets: number;
    softDeletedCreatives: number;
    softDeletedAds: number;
  };
}

export class MetaAdsService {
  constructor(
    private readonly repository: MetaAdsRepository,
    private readonly apiService: MetaApiService,
  ) {}

  async syncSelectedAccount(
    context: MetaApiContext,
    metaAccountId: string,
  ): Promise<MetaAdsHierarchySyncResult> {
    const account = await this.repository.findAccount(
      context.storeId,
      context.connectionId,
      metaAccountId,
    );
    if (!account) {
      throw new AppError(
        'Selected Meta ad account is missing from local configuration',
        409,
        'META_AD_ACCOUNT_NOT_CONFIGURED',
      );
    }

    const [accountProfile, campaigns, adSets, creatives, ads] = await Promise.all([
      this.apiService.getAdAccount(context, metaAccountId),
      this.fetchCampaigns(context, metaAccountId),
      this.fetchAdSets(context, metaAccountId),
      this.fetchCreatives(context, metaAccountId),
      this.fetchAds(context, metaAccountId),
    ]);

    const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
    for (const adSet of adSets) {
      if (!campaignIds.has(adSet.campaign_id)) {
        throw new AppError(
          `Meta ad set ${adSet.id} references campaign ${adSet.campaign_id} outside the account snapshot`,
          502,
          'META_HIERARCHY_INCONSISTENT',
        );
      }
    }

    const adSetIds = new Set(adSets.map((adSet) => adSet.id));
    for (const ad of ads) {
      if (!campaignIds.has(ad.campaign_id) || !adSetIds.has(ad.adset_id)) {
        throw new AppError(
          `Meta ad ${ad.id} references a parent outside the account snapshot`,
          502,
          'META_HIERARCHY_INCONSISTENT',
        );
      }
    }

    await this.repository.updateAccountProfile(account.id, {
      name: accountProfile.name,
      status: accountProfile.accountStatus,
      currency: accountProfile.currency,
      timezoneName: accountProfile.timezoneName,
      timezoneId: accountProfile.timezoneId,
      timezoneOffsetHours: accountProfile.timezoneOffsetHoursUtc,
      amountSpentMinor: accountProfile.amountSpentMinor,
      balanceMinor: accountProfile.balanceMinor,
      spendCapMinor: accountProfile.spendCapMinor,
      rawJson: accountProfile.raw,
    });

    const campaignMap = new Map<string, string>();
    for (const campaign of campaigns) {
      const saved = await this.repository.upsertCampaign(account.id, campaign);
      campaignMap.set(saved.metaCampaignId, saved.id);
    }

    const adSetMap = new Map<string, string>();
    for (const adSet of adSets) {
      const campaignId = campaignMap.get(adSet.campaign_id);
      if (!campaignId) {
        throw new AppError('Meta campaign parent was not persisted', 500, 'META_HIERARCHY_INCONSISTENT');
      }
      const saved = await this.repository.upsertAdSet(account.id, campaignId, adSet);
      adSetMap.set(saved.metaAdSetId, saved.id);
    }

    const creativeMap = new Map<string, string>();
    for (const creative of creatives) {
      const saved = await this.repository.upsertCreative(account.id, creative);
      creativeMap.set(saved.metaCreativeId, saved.id);
    }

    for (const ad of ads) {
      const campaignId = campaignMap.get(ad.campaign_id);
      const adSetId = adSetMap.get(ad.adset_id);
      if (!campaignId || !adSetId) {
        throw new AppError('Meta ad parent was not persisted', 500, 'META_HIERARCHY_INCONSISTENT');
      }
      const externalCreativeId = ad.creative?.id ?? null;
      const creativeId = externalCreativeId ? creativeMap.get(externalCreativeId) ?? null : null;
      await this.repository.upsertAd(account.id, campaignId, adSetId, creativeId, ad);
    }

    const deleted = await this.repository.softDeleteMissing(account.id, {
      campaignIds: campaigns.map((campaign) => campaign.id),
      adSetIds: adSets.map((adSet) => adSet.id),
      creativeIds: creatives.map((creative) => creative.id),
      adIds: ads.map((ad) => ad.id),
    });
    await this.repository.markAccountSynced(account.id);

    const recordsRead = 1 + campaigns.length + adSets.length + creatives.length + ads.length;
    const softDeleted = deleted.campaigns + deleted.adSets + deleted.creatives + deleted.ads;
    const recordsWritten = recordsRead + softDeleted;

    return {
      recordsRead,
      recordsWritten,
      breakdown: {
        adAccounts: 1,
        campaigns: campaigns.length,
        adSets: adSets.length,
        creatives: creatives.length,
        ads: ads.length,
        softDeletedCampaigns: deleted.campaigns,
        softDeletedAdSets: deleted.adSets,
        softDeletedCreatives: deleted.creatives,
        softDeletedAds: deleted.ads,
      },
    };
  }

  private fetchCampaigns(context: MetaApiContext, accountId: string): Promise<MetaCampaignPayload[]> {
    return this.apiService.collectGraphPages(
      context,
      `/${accountId}/campaigns`,
      { fields: CAMPAIGN_FIELDS, limit: PAGE_SIZE },
      (value) => parseOrThrow(metaCampaignSchema, value, 'campaign'),
    );
  }

  private fetchAdSets(context: MetaApiContext, accountId: string): Promise<MetaAdSetPayload[]> {
    return this.apiService.collectGraphPages(
      context,
      `/${accountId}/adsets`,
      { fields: ADSET_FIELDS, limit: PAGE_SIZE },
      (value) => parseOrThrow(metaAdSetSchema, value, 'ad set'),
    );
  }

  private fetchCreatives(context: MetaApiContext, accountId: string): Promise<MetaCreativePayload[]> {
    return this.apiService.collectGraphPages(
      context,
      `/${accountId}/adcreatives`,
      { fields: CREATIVE_FIELDS, limit: PAGE_SIZE },
      (value) => parseOrThrow(metaCreativeSchema, value, 'creative'),
    );
  }

  private fetchAds(context: MetaApiContext, accountId: string): Promise<MetaAdPayload[]> {
    return this.apiService.collectGraphPages(
      context,
      `/${accountId}/ads`,
      { fields: AD_FIELDS, limit: PAGE_SIZE },
      (value) => parseOrThrow(metaAdSchema, value, 'ad'),
    );
  }
}
