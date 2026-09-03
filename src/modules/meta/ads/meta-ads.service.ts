import { AppError } from '../../../errors/app-error.js';
import type { MetaApiContext } from '../meta.types.js';
import { parseMetaMinorAmount, parseMetaRecord, toJsonSafe } from '../meta.utils.js';
import type { MetaApiService } from '../shared/meta-api.service.js';
import type { MetaAdsRepository } from './meta-ads.repository.js';
import {
  metaAdSchema,
  metaAdSetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
} from './meta-ads.schema.js';
import { MetaStateRepository, type MetaStateCandidate } from './meta-state.repository.js';

const PAGE_SIZE = '100';
const CAMPAIGN_FIELDS = [
  'id', 'name', 'status', 'configured_status', 'effective_status', 'objective', 'buying_type',
  'bid_strategy', 'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap', 'start_time',
  'stop_time', 'promoted_object', 'recommendations', 'issues_info', 'created_time', 'updated_time',
].join(',');
const ADSET_FIELDS = [
  'id', 'campaign_id', 'name', 'status', 'configured_status', 'effective_status', 'daily_budget',
  'lifetime_budget', 'budget_remaining', 'daily_spend_cap', 'lifetime_spend_cap', 'bid_strategy',
  'bid_amount', 'bid_constraints', 'billing_event', 'optimization_goal', 'destination_type',
  'is_dynamic_creative', 'targeting', 'promoted_object', 'attribution_spec', 'start_time', 'end_time',
  'learning_stage_info', 'recommendations', 'issues_info', 'created_time', 'updated_time',
].join(',');
const CREATIVE_FIELDS = [
  'id', 'name', 'title', 'body', 'call_to_action', 'call_to_action_type', 'image_url', 'thumbnail_url',
  'video_id', 'link_url', 'link_deep_link_url', 'object_url', 'object_story_id',
  'effective_object_story_id', 'effective_instagram_media_id', 'instagram_permalink_url',
  'object_story_spec', 'product_set_id', 'product_data', 'asset_feed_spec', 'degrees_of_freedom_spec',
  'template_url', 'template_url_spec', 'url_tags', 'created_time', 'updated_time',
].join(',');
const AD_FIELDS = [
  'id', 'campaign_id', 'adset_id', 'name', 'status', 'configured_status', 'effective_status',
  'conversion_domain', 'source_ad_id', 'creative{id}', 'placement', 'tracking_specs', 'conversion_specs',
  'recommendations', 'issues_info', 'adlabels', 'created_time', 'updated_time',
].join(',');

export class MetaAdsService {
  constructor(
    private readonly repository: MetaAdsRepository,
    private readonly apiService: MetaApiService,
    private readonly stateRepository: MetaStateRepository = new MetaStateRepository(),
  ) {}

  async syncSelectedAccount(context: MetaApiContext, metaAccountId: string) {
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

    // Fetch the full provider snapshot before mutating current state so a partial fetch can never
    // look like provider deletions.
    const [accountProfile, campaigns, adSets, creatives, ads] = await Promise.all([
      this.apiService.getAdAccount(context, metaAccountId),
      this.apiService.collectGraphPages(
        context,
        `/${metaAccountId}/campaigns`,
        { fields: CAMPAIGN_FIELDS, limit: PAGE_SIZE },
        (value) => parseMetaRecord(metaCampaignSchema, value, 'Meta campaign response was invalid'),
      ),
      this.apiService.collectGraphPages(
        context,
        `/${metaAccountId}/adsets`,
        { fields: ADSET_FIELDS, limit: PAGE_SIZE },
        (value) => parseMetaRecord(metaAdSetSchema, value, 'Meta ad set response was invalid'),
      ),
      this.apiService.collectGraphPages(
        context,
        `/${metaAccountId}/adcreatives`,
        { fields: CREATIVE_FIELDS, limit: PAGE_SIZE },
        (value) => parseMetaRecord(metaCreativeSchema, value, 'Meta creative response was invalid'),
      ),
      this.apiService.collectGraphPages(
        context,
        `/${metaAccountId}/ads`,
        { fields: AD_FIELDS, limit: PAGE_SIZE },
        (value) => parseMetaRecord(metaAdSchema, value, 'Meta ad response was invalid'),
      ),
    ]);

    const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
    if (adSets.some((adSet) => !campaignIds.has(adSet.campaign_id))) {
      throw new AppError(
        'Meta ad set references a campaign outside the account snapshot',
        502,
        'META_HIERARCHY_INCONSISTENT',
      );
    }

    const adSetIds = new Set(adSets.map((adSet) => adSet.id));
    if (ads.some((ad) => !campaignIds.has(ad.campaign_id) || !adSetIds.has(ad.adset_id))) {
      throw new AppError(
        'Meta ad references a parent outside the account snapshot',
        502,
        'META_HIERARCHY_INCONSISTENT',
      );
    }

    const baseline = await this.stateRepository.loadBaseline(account.id);

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

    const adMap = new Map<string, string>();
    for (const ad of ads) {
      const campaignId = campaignMap.get(ad.campaign_id);
      const adSetId = adSetMap.get(ad.adset_id);
      if (!campaignId || !adSetId) {
        throw new AppError('Meta ad parent was not persisted', 500, 'META_HIERARCHY_INCONSISTENT');
      }
      const externalCreativeId = ad.creative?.id;
      const saved = await this.repository.upsertAd(
        account.id,
        campaignId,
        adSetId,
        externalCreativeId ? creativeMap.get(externalCreativeId) ?? null : null,
        ad,
      );
      adMap.set(saved.metaAdId, saved.id);
    }

    const stateCandidates: MetaStateCandidate[] = [
      ...campaigns.map((campaign) => ({
        entityType: 'CAMPAIGN' as const,
        localEntityId: campaignMap.get(campaign.id)!,
        externalEntityId: campaign.id,
        configuredStatus: campaign.configured_status ?? campaign.status ?? null,
        effectiveStatus: campaign.effective_status ?? null,
        objective: campaign.objective ?? null,
        optimizationGoal: null,
        bidStrategy: campaign.bid_strategy ?? null,
        dailyBudgetMinor: parseMetaMinorAmount(campaign.daily_budget),
        lifetimeBudgetMinor: parseMetaMinorAmount(campaign.lifetime_budget),
        budgetRemainingMinor: parseMetaMinorAmount(campaign.budget_remaining),
        spendCapMinor: parseMetaMinorAmount(campaign.spend_cap),
      })),
      ...adSets.map((adSet) => ({
        entityType: 'AD_SET' as const,
        localEntityId: adSetMap.get(adSet.id)!,
        externalEntityId: adSet.id,
        configuredStatus: adSet.configured_status ?? adSet.status ?? null,
        effectiveStatus: adSet.effective_status ?? null,
        objective: null,
        optimizationGoal: adSet.optimization_goal ?? null,
        bidStrategy: adSet.bid_strategy ?? null,
        dailyBudgetMinor: parseMetaMinorAmount(adSet.daily_budget),
        lifetimeBudgetMinor: parseMetaMinorAmount(adSet.lifetime_budget),
        budgetRemainingMinor: parseMetaMinorAmount(adSet.budget_remaining),
        spendCapMinor:
          parseMetaMinorAmount(adSet.lifetime_spend_cap) ?? parseMetaMinorAmount(adSet.daily_spend_cap),
      })),
      ...ads.map((ad) => ({
        entityType: 'AD' as const,
        localEntityId: adMap.get(ad.id)!,
        externalEntityId: ad.id,
        configuredStatus: ad.configured_status ?? ad.status ?? null,
        effectiveStatus: ad.effective_status ?? null,
        objective: null,
        optimizationGoal: null,
        bidStrategy: null,
        dailyBudgetMinor: null,
        lifetimeBudgetMinor: null,
        budgetRemainingMinor: null,
        spendCapMinor: null,
      })),
    ];
    const stateSnapshotsWritten = await this.stateRepository.recordChanges(
      context.storeId,
      account.id,
      baseline,
      stateCandidates,
    );

    const deleted = await this.repository.softDeleteMissing(account.id, {
      campaignIds: campaigns.map((campaign) => campaign.id),
      adSetIds: adSets.map((adSet) => adSet.id),
      creativeIds: creatives.map((creative) => creative.id),
      adIds: ads.map((ad) => ad.id),
    });
    await this.repository.markAccountSynced(account.id);

    const recordsRead = 1 + campaigns.length + adSets.length + creatives.length + ads.length;
    const softDeleted = deleted.campaigns + deleted.adSets + deleted.creatives + deleted.ads;
    return {
      recordsRead,
      recordsWritten: recordsRead + softDeleted + stateSnapshotsWritten,
      breakdown: {
        adAccounts: 1,
        campaigns: campaigns.length,
        adSets: adSets.length,
        creatives: creatives.length,
        ads: ads.length,
        stateSnapshots: stateSnapshotsWritten,
        softDeletedCampaigns: deleted.campaigns,
        softDeletedAdSets: deleted.adSets,
        softDeletedCreatives: deleted.creatives,
        softDeletedAds: deleted.ads,
      },
    };
  }

  async listAdAccounts(storeId: string) {
    return toJsonSafe(await this.repository.listAdAccounts(storeId));
  }

  async listCampaigns(
    storeId: string,
    input: { adAccountId?: string; status?: string; page: number; limit: number },
  ) {
    return toJsonSafe(await this.repository.listCampaigns(storeId, input));
  }

  async listAdSets(
    storeId: string,
    input: { campaignId?: string; status?: string; page: number; limit: number },
  ) {
    return toJsonSafe(await this.repository.listAdSets(storeId, input));
  }

  async listAds(
    storeId: string,
    input: { campaignId?: string; adSetId?: string; status?: string; page: number; limit: number },
  ) {
    return toJsonSafe(await this.repository.listAds(storeId, input));
  }

  async getAd(storeId: string, metaAdId: string) {
    const ad = await this.repository.getAd(storeId, metaAdId);
    if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
    return toJsonSafe(ad);
  }
}
