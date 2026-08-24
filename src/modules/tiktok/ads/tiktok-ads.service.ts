import { AppError } from '../../../errors/app-error.js';
import type { TikTokApiService } from '../shared/tiktok-api.service.js';
import type { TikTokApiContext, TikTokObject } from '../tiktok.types.js';
import { asNumber, asRecord, asString, asStringArray, parseTikTokDate } from '../tiktok.utils.js';
import type { TikTokAdsRepository } from './tiktok-ads.repository.js';

function value(record: TikTokObject, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}
function stringValue(record: TikTokObject, ...keys: string[]) { return asString(value(record, ...keys)); }
function numberValue(record: TikTokObject, ...keys: string[]) { return asNumber(value(record, ...keys)); }
function boolValue(record: TikTokObject, ...keys: string[]): boolean | null {
  const raw = value(record, ...keys);
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === 0 || raw === '0' || raw === 'false') return false;
  return null;
}
function campaignId(record: TikTokObject): string | null { return stringValue(record, 'campaign_id', 'smart_plus_campaign_id'); }
function adGroupId(record: TikTokObject): string | null { return stringValue(record, 'adgroup_id', 'ad_group_id', 'smart_plus_adgroup_id'); }
function adId(record: TikTokObject): string | null { return stringValue(record, 'ad_id', 'smart_plus_ad_id'); }

function extractCreative(record: TikTokObject) {
  const creativeList = Array.isArray(record.creative_list) ? record.creative_list.map(asRecord) : [];
  const firstCreative = creativeList[0] ?? asRecord(record.creative);
  const videoInfo = asRecord(firstCreative.video_info ?? record.video_info);
  const imageInfo = asRecord(firstCreative.image_info ?? record.image_info);
  const adConfiguration = asRecord(record.ad_configuration);
  const landingUrls = asStringArray(record.landing_page_url_list);
  const adTexts = asStringArray(record.ad_text_list);
  return {
    adFormat: stringValue(record, 'ad_format', 'image_mode', 'creative_type'),
    creativeMaterialMode: stringValue(record, 'creative_material_mode'),
    identityId: stringValue(record, 'identity_id'),
    identityType: stringValue(record, 'identity_type'),
    sparkAdPostId: stringValue(record, 'tiktok_item_id', 'spark_ad_post_id'),
    videoId: asString(videoInfo.video_id) ?? stringValue(record, 'video_id'),
    imageIds: record.image_ids ?? imageInfo.image_ids ?? (record.image_id ? [record.image_id] : null),
    thumbnailUrl: asString(videoInfo.cover_url) ?? asString(imageInfo.web_uri) ?? stringValue(record, 'thumbnail_url'),
    adText: stringValue(record, 'ad_text') ?? adTexts[0] ?? null,
    displayName: stringValue(record, 'display_name'),
    callToAction: stringValue(record, 'call_to_action') ?? asString(adConfiguration.call_to_action_id) ?? null,
    landingPageUrl: stringValue(record, 'landing_page_url') ?? landingUrls[0] ?? null,
    trackingPixelId: stringValue(record, 'pixel_id', 'tracking_pixel_id'),
    catalogId: stringValue(record, 'catalog_id'),
    productSetId: stringValue(record, 'product_set_id'),
    tracking: record.tracking ?? record.tracking_url ?? record.impression_tracking_url,
    creativeJson: creativeList.length > 0 ? { creativeList, adConfiguration, adTexts, landingUrls } : firstCreative,
  };
}

export class TikTokAdsService {
  constructor(
    private readonly repository: TikTokAdsRepository,
    private readonly apiService: TikTokApiService,
  ) {}

  listCampaigns(storeId: string, input: { page: number; limit: number; advertiserId?: string; status?: string }) {
    return this.repository.listCampaigns(storeId, input).then(([items, total]) => ({ items, page: input.page, limit: input.limit, total }));
  }

  listAdGroups(storeId: string, input: { page: number; limit: number; campaignId?: string; status?: string }) {
    return this.repository.listAdGroups(storeId, input).then(([items, total]) => ({ items, page: input.page, limit: input.limit, total }));
  }

  listAds(storeId: string, input: { page: number; limit: number; campaignId?: string; adGroupId?: string; status?: string }) {
    return this.repository.listAds(storeId, input).then(([items, total]) => ({ items, page: input.page, limit: input.limit, total }));
  }

  async getAd(storeId: string, externalAdId: string) {
    const ad = await this.repository.getAd(storeId, externalAdId);
    if (!ad) throw new AppError('TikTok ad not found', 404, 'TIKTOK_AD_NOT_FOUND');
    return ad;
  }

  async syncSelectedAdvertisers(storeId: string, context: TikTokApiContext) {
    let recordsRead = 0;
    let recordsWritten = 0;
    const advertisers = await this.repository.findSelectedAdvertisers(storeId, context.selectedAdvertiserIds);

    for (const advertiser of advertisers) {
      const campaigns = await this.apiService.paginate(context, 'campaign/get', { advertiser_id: advertiser.advertiserId }, ['list']);
      recordsRead += campaigns.length;
      const campaignIds: string[] = [];
      const campaignDbByExternal = new Map<string, string>();
      for (const record of campaigns) {
        const externalId = campaignId(record);
        if (!externalId) continue;
        campaignIds.push(externalId);
        const campaign = await this.repository.upsertCampaign({
          advertiserDbId: advertiser.id,
          tiktokCampaignId: externalId,
          name: stringValue(record, 'campaign_name', 'name') ?? externalId,
          objectiveType: stringValue(record, 'objective_type'),
          campaignType: stringValue(record, 'campaign_type'),
          operationStatus: stringValue(record, 'operation_status', 'status'),
          secondaryStatus: stringValue(record, 'secondary_status'),
          budgetMode: stringValue(record, 'budget_mode'),
          budget: numberValue(record, 'budget'),
          deepBidType: stringValue(record, 'deep_bid_type'),
          roasBid: numberValue(record, 'roas_bid'),
          isSmartPerformance: boolValue(record, 'is_smart_performance_campaign'),
          tiktokCreatedAt: parseTikTokDate(value(record, 'create_time', 'create_time_string')),
          tiktokUpdatedAt: parseTikTokDate(value(record, 'modify_time', 'modify_time_string')),
          raw: record,
        });
        campaignDbByExternal.set(externalId, campaign.id);
        recordsWritten += 1;
      }
      await this.repository.tombstoneMissingCampaigns(advertiser.id, campaignIds);

      const adGroups = await this.apiService.paginate(context, 'adgroup/get', { advertiser_id: advertiser.advertiserId }, ['list']);
      recordsRead += adGroups.length;
      const adGroupIds: string[] = [];
      const adGroupDbByExternal = new Map<string, string>();
      for (const record of adGroups) {
        const externalId = adGroupId(record);
        const externalCampaignId = campaignId(record);
        const localCampaignId = externalCampaignId ? campaignDbByExternal.get(externalCampaignId) : undefined;
        if (!externalId || !localCampaignId) continue;
        adGroupIds.push(externalId);
        const group = await this.repository.upsertAdGroup({
          advertiserDbId: advertiser.id, campaignId: localCampaignId, tiktokAdGroupId: externalId,
          name: stringValue(record, 'adgroup_name', 'ad_group_name', 'name') ?? externalId,
          operationStatus: stringValue(record, 'operation_status', 'status'), secondaryStatus: stringValue(record, 'secondary_status'),
          placementType: stringValue(record, 'placement_type'), placements: value(record, 'placements', 'placement'),
          promotionType: stringValue(record, 'promotion_type'), optimizationGoal: stringValue(record, 'optimization_goal'),
          optimizationEvent: stringValue(record, 'optimization_event'), billingEvent: stringValue(record, 'billing_event'),
          bidType: stringValue(record, 'bid_type'), bidPrice: numberValue(record, 'bid_price'), deepBidType: stringValue(record, 'deep_bid_type'),
          roasBid: numberValue(record, 'roas_bid'), budgetMode: stringValue(record, 'budget_mode'), budget: numberValue(record, 'budget'),
          scheduleType: stringValue(record, 'schedule_type'), scheduleStartTime: parseTikTokDate(value(record, 'schedule_start_time')),
          scheduleEndTime: parseTikTokDate(value(record, 'schedule_end_time')), dayparting: stringValue(record, 'dayparting'),
          pixelId: stringValue(record, 'pixel_id'), catalogId: stringValue(record, 'catalog_id'), productSetId: stringValue(record, 'product_set_id'),
          productSource: stringValue(record, 'product_source'), targeting: value(record, 'targeting', 'audience'), attribution: value(record, 'attribution_window', 'attribution'),
          tiktokCreatedAt: parseTikTokDate(value(record, 'create_time')), tiktokUpdatedAt: parseTikTokDate(value(record, 'modify_time')), raw: record,
        });
        adGroupDbByExternal.set(externalId, group.id);
        recordsWritten += 1;
      }
      await this.repository.tombstoneMissingAdGroups(advertiser.id, adGroupIds);

      const ads = await this.apiService.paginate(context, 'ad/get', { advertiser_id: advertiser.advertiserId }, ['list']);
      recordsRead += ads.length;
      const activeAdIds: string[] = [];
      for (const record of ads) {
        const externalId = adId(record);
        const externalCampaignId = campaignId(record);
        const externalAdGroupId = adGroupId(record);
        const localCampaignId = externalCampaignId ? campaignDbByExternal.get(externalCampaignId) : undefined;
        const localAdGroupId = externalAdGroupId ? adGroupDbByExternal.get(externalAdGroupId) : undefined;
        if (!externalId || !localCampaignId || !localAdGroupId) continue;
        activeAdIds.push(externalId);
        await this.repository.upsertAd({
          advertiserDbId: advertiser.id, campaignId: localCampaignId, adGroupId: localAdGroupId,
          tiktokAdId: externalId, name: stringValue(record, 'ad_name', 'name') ?? externalId,
          operationStatus: stringValue(record, 'operation_status', 'status'), secondaryStatus: stringValue(record, 'secondary_status'),
          ...extractCreative(record),
          tiktokCreatedAt: parseTikTokDate(value(record, 'create_time')), tiktokUpdatedAt: parseTikTokDate(value(record, 'modify_time')), raw: record,
        });
        recordsWritten += 1;
      }
      await this.repository.tombstoneMissingAds(advertiser.id, activeAdIds);
    }

    return { recordsRead, recordsWritten };
  }
}
