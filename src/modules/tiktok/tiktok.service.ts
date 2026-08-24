import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { IntegrationService } from '../integrations/integration.service.js';
import {
  resolveTikTokAd,
  resolveTikTokCatalogItem,
  type CatalogResolution,
  type TikTokMappingAd,
  type TikTokMappingCatalogItem,
  type TikTokMappingVariant,
} from './tiktok.mapping.js';
import type { TikTokRepository } from './tiktok.repository.js';
import type { TikTokApiContext, TikTokObject } from './tiktok.types.js';
import { asNumber, asRecord, asString, asStringArray, parseTikTokDate, toJsonSafe } from './tiktok.utils.js';
import type { TikTokApiService } from './shared/tiktok-api.service.js';
import type { TikTokAuthService } from './shared/tiktok-auth.service.js';

const ADS_HIERARCHY_RESOURCE = 'AdsHierarchy';
const CATALOG_RESOURCE = 'ProductCatalogs';
const INSIGHTS_RESOURCE = 'AdInsightsDaily';
const DEFAULT_INSIGHTS_LOOKBACK_DAYS = 35;
const REPORT_CHUNK_DAYS = 28;

function value(record: TikTokObject, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}

function stringValue(record: TikTokObject, ...keys: string[]) {
  return asString(value(record, ...keys));
}

function numberValue(record: TikTokObject, ...keys: string[]) {
  return asNumber(value(record, ...keys));
}

function boolValue(record: TikTokObject, ...keys: string[]): boolean | null {
  const raw = value(record, ...keys);
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === 0 || raw === '0' || raw === 'false') return false;
  return null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateChunks(lookbackDays: number): Array<{ start: string; end: string }> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(0, lookbackDays - 1));
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + REPORT_CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: formatDate(cursor), end: formatDate(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function campaignId(record: TikTokObject): string | null {
  return stringValue(record, 'campaign_id', 'smart_plus_campaign_id');
}

function adGroupId(record: TikTokObject): string | null {
  return stringValue(record, 'adgroup_id', 'ad_group_id', 'smart_plus_adgroup_id');
}

function adId(record: TikTokObject): string | null {
  return stringValue(record, 'ad_id', 'smart_plus_ad_id');
}

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

export class TikTokService {
  constructor(
    private readonly repository: TikTokRepository,
    private readonly authService: TikTokAuthService,
    private readonly apiService: TikTokApiService,
    private readonly integrationService: IntegrationService,
  ) {}

  startOAuthInstall(userId: string, storeId: string) {
    return this.authService.startInstall(userId, storeId);
  }

  completeOAuthInstall(authCode: string, state: string) {
    return this.authService.completeInstall(authCode, state);
  }

  async getStatus(storeId: string) {
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection) return null;
    return {
      id: connection.id,
      status: connection.status,
      businessCenterId: connection.businessCenterId,
      selectedAdvertiserIds: connection.selectedAdvertiserIds,
      selectedCatalogIds: connection.selectedCatalogIds,
      scopes: connection.scopes,
      apiVersion: connection.apiVersion,
      lastSyncedAt: connection.lastSyncedAt,
    };
  }

  async discoverAssets(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const [authorized, businessCenters] = await Promise.all([
      this.apiService.listAuthorizedAdvertisers(context.accessToken),
      this.apiService.listBusinessCenters(context).catch(() => []),
    ]);
    const authorizedIds = [...new Set(authorized.map((item) => item.advertiser_id))];
    const advertiserRecords = await this.apiService.getAdvertiserInfo(context, authorizedIds);
    const advertisers = advertiserRecords.length > 0
      ? advertiserRecords.map((record) => this.toAdvertiserAsset(record))
      : authorized.map((record) => ({ advertiserId: record.advertiser_id, name: record.advertiser_name ?? record.advertiser_id, status: null, currency: null, timezone: null, countryCode: null }));

    const catalogs: Array<Record<string, unknown>> = [];
    for (const businessCenter of businessCenters) {
      const found = await this.apiService.paginate(
        context,
        'catalog/get',
        { bc_id: businessCenter.bc_id },
        ['catalogs', 'list'],
      ).catch(() => []);
      for (const catalog of found) catalogs.push({ ...catalog, business_center_id: businessCenter.bc_id });
    }

    return {
      businessCenters: businessCenters.map((item) => ({ id: item.bc_id, name: item.name ?? item.bc_id, status: item.status ?? null, currency: item.currency ?? null, timezone: item.timezone ?? null })),
      advertisers,
      catalogs: catalogs.map((item) => this.toCatalogAsset(item)),
      permissions: { granted: context.scopes },
    };
  }

  async configureAssets(storeId: string, input: { businessCenterId?: string | null; advertiserIds: string[] }) {
    const context = await this.authService.getApiContext(storeId);
    const authorized = await this.apiService.listAuthorizedAdvertisers(context.accessToken);
    const authorizedIds = new Set(authorized.map((item) => item.advertiser_id));
    const missing = input.advertiserIds.filter((id) => !authorizedIds.has(id));
    if (missing.length > 0) {
      throw new AppError('Selected TikTok advertiser is not accessible', 400, 'TIKTOK_ADVERTISER_NOT_ACCESSIBLE', { advertiserIds: missing });
    }

    let businessCenterId = input.businessCenterId ?? null;
    if (businessCenterId) {
      const centers = await this.apiService.listBusinessCenters(context);
      if (!centers.some((center) => center.bc_id === businessCenterId)) {
        throw new AppError('Selected TikTok Business Center is not accessible', 400, 'TIKTOK_BUSINESS_CENTER_NOT_ACCESSIBLE');
      }
    }

    const advertiserRecords = await this.apiService.getAdvertiserInfo(context, input.advertiserIds);
    const byId = new Map(advertiserRecords.map((record) => [stringValue(record, 'advertiser_id'), record]));
    for (const advertiserId of input.advertiserIds) {
      const record = byId.get(advertiserId) ?? { advertiser_id: advertiserId, name: authorized.find((item) => item.advertiser_id === advertiserId)?.advertiser_name ?? advertiserId };
      const asset = this.toAdvertiserAsset(record);
      await this.repository.upsertAdvertiser({ storeId, connectionId: context.connectionId, ...asset, raw: record });
    }
    await this.repository.configureAssets(context.connectionId, businessCenterId, input.advertiserIds);
    return this.getStatus(storeId);
  }

  async configureCatalogs(storeId: string, catalogIds: string[]) {
    const context = await this.authService.getApiContext(storeId);
    if (!context.businessCenterId && catalogIds.length > 0) {
      throw new AppError('Select a TikTok Business Center before selecting catalogs', 400, 'TIKTOK_BUSINESS_CENTER_REQUIRED');
    }
    const accessible = context.businessCenterId
      ? await this.apiService.paginate(context, 'catalog/get', { bc_id: context.businessCenterId }, ['catalogs', 'list'])
      : [];
    const byId = new Map(accessible.map((record) => [stringValue(record, 'catalog_id', 'id'), record]));
    const missing = catalogIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new AppError('Selected TikTok catalog is not accessible', 400, 'TIKTOK_CATALOG_NOT_ACCESSIBLE', { catalogIds: missing });

    for (const id of catalogIds) {
      const record = byId.get(id)!;
      await this.repository.upsertCatalog({ storeId, connectionId: context.connectionId, ...this.toCatalogAsset(record), raw: record });
    }
    await this.repository.configureCatalogs(context.connectionId, catalogIds);
    return this.getStatus(storeId);
  }

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

  listCatalogs(storeId: string) {
    return this.repository.listCatalogs(storeId);
  }

  listCatalogItems(storeId: string, catalogId: string, page: number, limit: number) {
    return this.repository.listCatalogItems(storeId, catalogId, page, limit).then(([items, total]) => ({ items, page, limit, total }));
  }

  listInsights(storeId: string, input: { page: number; limit: number; from: string; to: string; advertiserId?: string; campaignId?: string; adGroupId?: string; adId?: string }) {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T00:00:00.000Z`);
    return this.repository.listInsights(storeId, { ...input, from, to }).then(([items, total]) => ({ items, page: input.page, limit: input.limit, total }));
  }

  async syncAdsHierarchy(storeId: string) {
    const context = await this.requireConfiguredContext(storeId);
    const syncRun = await this.integrationService.startSyncRun({ provider: 'TIKTOK', connectionId: context.connectionId, resourceType: ADS_HIERARCHY_RESOURCE, mode: 'FULL', apiVersion: context.apiVersion });
    let read = 0;
    let written = 0;
    try {
      const advertisers = await this.repository.findSelectedAdvertisers(storeId, context.selectedAdvertiserIds);
      for (const advertiser of advertisers) {
        const campaigns = await this.apiService.paginate(context, 'campaign/get', { advertiser_id: advertiser.advertiserId }, ['list']);
        read += campaigns.length;
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
          written += 1;
        }
        await this.repository.tombstoneMissingCampaigns(advertiser.id, campaignIds);

        const adGroups = await this.apiService.paginate(context, 'adgroup/get', { advertiser_id: advertiser.advertiserId }, ['list']);
        read += adGroups.length;
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
          written += 1;
        }
        await this.repository.tombstoneMissingAdGroups(advertiser.id, adGroupIds);

        const ads = await this.apiService.paginate(context, 'ad/get', { advertiser_id: advertiser.advertiserId }, ['list']);
        read += ads.length;
        const activeAdIds: string[] = [];
        for (const record of ads) {
          const externalId = adId(record);
          const externalCampaignId = campaignId(record);
          const externalAdGroupId = adGroupId(record);
          const localCampaignId = externalCampaignId ? campaignDbByExternal.get(externalCampaignId) : undefined;
          const localAdGroupId = externalAdGroupId ? adGroupDbByExternal.get(externalAdGroupId) : undefined;
          if (!externalId || !localCampaignId || !localAdGroupId) continue;
          activeAdIds.push(externalId);
          const creative = extractCreative(record);
          await this.repository.upsertAd({
            advertiserDbId: advertiser.id, campaignId: localCampaignId, adGroupId: localAdGroupId,
            tiktokAdId: externalId, name: stringValue(record, 'ad_name', 'name') ?? externalId,
            operationStatus: stringValue(record, 'operation_status', 'status'), secondaryStatus: stringValue(record, 'secondary_status'),
            ...creative,
            tiktokCreatedAt: parseTikTokDate(value(record, 'create_time')), tiktokUpdatedAt: parseTikTokDate(value(record, 'modify_time')), raw: record,
          });
          written += 1;
        }
        await this.repository.tombstoneMissingAds(advertiser.id, activeAdIds);
      }
      await this.integrationService.recordExternalPayload({ provider: 'TIKTOK', resourceType: ADS_HIERARCHY_RESOURCE, apiVersion: context.apiVersion, payload: toJsonSafe({ advertiserIds: context.selectedAdvertiserIds, recordsRead: read, recordsWritten: written }), syncRunId: syncRun.id });
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead: read, recordsWritten: written });
      await this.repository.markConnectionSynced(context.connectionId);
      await this.resolveMappings(storeId);
      return { syncRunId: syncRun.id, recordsRead: read, recordsWritten: written };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error);
      if (error instanceof AppError && error.code === 'TIKTOK_REAUTH_REQUIRED') await this.repository.markConnectionReauthRequired(context.connectionId);
      throw error;
    }
  }

  async syncCatalogs(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    if (!context.businessCenterId) throw new AppError('TikTok Business Center is not configured', 409, 'TIKTOK_BUSINESS_CENTER_REQUIRED');
    const syncRun = await this.integrationService.startSyncRun({ provider: 'TIKTOK', connectionId: context.connectionId, resourceType: CATALOG_RESOURCE, mode: 'FULL', apiVersion: context.apiVersion });
    let read = 0;
    let written = 0;
    try {
      const catalogs = await this.apiService.paginate(context, 'catalog/get', { bc_id: context.businessCenterId }, ['catalogs', 'list']);
      const selected = catalogs.filter((record) => {
        const id = stringValue(record, 'catalog_id', 'id');
        return id ? context.selectedCatalogIds.includes(id) : false;
      });
      for (const record of selected) {
        const asset = this.toCatalogAsset(record);
        const catalog = await this.repository.upsertCatalog({ storeId, connectionId: context.connectionId, ...asset, businessCenterId: context.businessCenterId, raw: record });
        written += 1;
        const items = await this.apiService.paginate(context, 'catalog/product/get', { bc_id: context.businessCenterId, catalog_id: asset.tiktokCatalogId }, ['products', 'list']);
        read += items.length;
        const ids: string[] = [];
        for (const item of items) {
          const externalId = stringValue(item, 'product_id', 'id');
          if (!externalId) continue;
          ids.push(externalId);
          const price = asRecord(value(item, 'price'));
          const salePrice = asRecord(value(item, 'sale_price'));
          await this.repository.upsertCatalogItem({
            catalogId: catalog.id, tiktokProductId: externalId,
            retailerId: stringValue(item, 'retailer_id', 'sku'), itemGroupId: stringValue(item, 'item_group_id', 'retailer_product_group_id'),
            title: stringValue(item, 'title', 'name'), description: stringValue(item, 'description'), brand: stringValue(item, 'brand'),
            availability: stringValue(item, 'availability'), price: numberValue(item, 'price') ?? asNumber(price.price),
            salePrice: numberValue(item, 'sale_price') ?? asNumber(salePrice.price), currency: stringValue(item, 'currency') ?? asString(price.currency),
            size: stringValue(item, 'size'), color: stringValue(item, 'color'), pattern: stringValue(item, 'pattern'),
            url: stringValue(item, 'link', 'url'), imageUrl: stringValue(item, 'image_link', 'image_url'), productType: stringValue(item, 'product_type'),
            category: stringValue(item, 'category', 'google_product_category'), customLabels: value(item, 'custom_labels'), variants: value(item, 'variants'),
            videoIds: value(item, 'video_ids'), status: stringValue(item, 'status'), raw: item,
          });
          written += 1;
        }
        await this.repository.tombstoneMissingCatalogItems(catalog.id, ids);
      }
      await this.integrationService.recordExternalPayload({ provider: 'TIKTOK', resourceType: CATALOG_RESOURCE, apiVersion: context.apiVersion, payload: toJsonSafe({ selectedCatalogIds: context.selectedCatalogIds, recordsRead: read, recordsWritten: written }), syncRunId: syncRun.id });
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead: read, recordsWritten: written });
      await this.resolveMappings(storeId);
      return { syncRunId: syncRun.id, recordsRead: read, recordsWritten: written };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error);
      throw error;
    }
  }

  async syncInsights(storeId: string, lookbackDays = DEFAULT_INSIGHTS_LOOKBACK_DAYS) {
    const context = await this.requireConfiguredContext(storeId);
    const syncRun = await this.integrationService.startSyncRun({ provider: 'TIKTOK', connectionId: context.connectionId, resourceType: INSIGHTS_RESOURCE, mode: 'INCREMENTAL', apiVersion: context.apiVersion });
    let read = 0;
    let written = 0;
    try {
      for (const advertiserId of context.selectedAdvertiserIds) {
        for (const chunk of dateChunks(lookbackDays)) {
          const rows = await this.apiService.paginate(context, 'report/integrated/get', {
            advertiser_id: advertiserId,
            report_type: 'BASIC',
            data_level: 'AUCTION_AD',
            dimensions: ['ad_id', 'stat_time_day'],
            metrics: [
              'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'frequency',
              'complete_payment', 'cost_per_complete_payment', 'complete_payment_roas', 'total_complete_payment_rate',
              'video_play_actions', 'video_watched_2s', 'video_watched_6s', 'video_views_p25', 'video_views_p50', 'video_views_p75', 'video_views_p100',
            ],
            start_date: chunk.start,
            end_date: chunk.end,
          }, ['list']);
          read += rows.length;
          for (const row of rows) {
            const dimensions = asRecord(row.dimensions);
            const metrics = asRecord(row.metrics);
            const externalAdId = asString(dimensions.ad_id) ?? stringValue(row, 'ad_id');
            const dateText = asString(dimensions.stat_time_day) ?? stringValue(row, 'stat_time_day');
            if (!externalAdId || !dateText) continue;
            const localAd = await this.repository.getAd(storeId, externalAdId);
            if (!localAd || localAd.advertiser.advertiserId !== advertiserId) continue;
            const date = new Date(`${dateText.slice(0, 10)}T00:00:00.000Z`);
            if (Number.isNaN(date.getTime())) continue;
            const insightKey = createHash('sha256').update(['TIKTOK', advertiserId, externalAdId, formatDate(date)].join(':')).digest('hex');
            await this.repository.upsertInsight({
              insightKey, advertiserDbId: localAd.advertiserDbId, campaignId: localAd.campaignId, adGroupId: localAd.adGroupId, adId: localAd.id,
              level: 'AD', date, accountCurrency: localAd.advertiser.currency,
              spend: asNumber(metrics.spend) ?? 0, impressions: BigInt(asString(metrics.impressions) ?? '0'), reach: metrics.reach == null ? null : BigInt(asString(metrics.reach) ?? '0'),
              clicks: BigInt(asString(metrics.clicks) ?? '0'), ctr: asNumber(metrics.ctr), cpc: asNumber(metrics.cpc), cpm: asNumber(metrics.cpm), frequency: asNumber(metrics.frequency),
              conversions: asNumber(metrics.complete_payment), conversionValue: asNumber(metrics.total_complete_payment_rate), costPerConversion: asNumber(metrics.cost_per_complete_payment), roas: asNumber(metrics.complete_payment_roas),
              videoPlayActions: metrics.video_play_actions == null ? null : BigInt(asString(metrics.video_play_actions) ?? '0'),
              videoWatched2s: metrics.video_watched_2s == null ? null : BigInt(asString(metrics.video_watched_2s) ?? '0'),
              videoWatched6s: metrics.video_watched_6s == null ? null : BigInt(asString(metrics.video_watched_6s) ?? '0'),
              videoViewsP25: metrics.video_views_p25 == null ? null : BigInt(asString(metrics.video_views_p25) ?? '0'), videoViewsP50: metrics.video_views_p50 == null ? null : BigInt(asString(metrics.video_views_p50) ?? '0'),
              videoViewsP75: metrics.video_views_p75 == null ? null : BigInt(asString(metrics.video_views_p75) ?? '0'), videoViewsP100: metrics.video_views_p100 == null ? null : BigInt(asString(metrics.video_views_p100) ?? '0'),
              dimensionsJson: dimensions, metricsJson: metrics, rawJson: row, syncedAt: new Date(),
            });
            written += 1;
          }
        }
      }
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead: read, recordsWritten: written });
      await this.repository.markConnectionSynced(context.connectionId);
      return { syncRunId: syncRun.id, recordsRead: read, recordsWritten: written };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error);
      throw error;
    }
  }

  async resolveMappings(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const dataset = await this.repository.getMappingDataset(storeId, context.selectedCatalogIds, context.selectedAdvertiserIds);
    if (!dataset) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const hosts = new Set([dataset.myshopifyDomain, dataset.primaryDomainHost].filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase().replace(/^www\./, '')));
    const variants: TikTokMappingVariant[] = dataset.variants.map((variant) => ({
      id: variant.id, productId: variant.productId, shopifyVariantId: variant.shopifyVariantId, sku: variant.sku, barcode: variant.barcode,
      shopifyProductId: variant.product.shopifyProductId, productHandle: variant.product.handle, productTitle: variant.product.title, options: variant.options,
    }));
    const catalogItems: TikTokMappingCatalogItem[] = dataset.tiktokCatalogs.flatMap((catalog) => catalog.items);
    const catalogResolutions = new Map<string, CatalogResolution>();
    for (const item of catalogItems) {
      const resolution = resolveTikTokCatalogItem(item, variants, hosts);
      catalogResolutions.set(item.id, resolution);
      if (resolution.source) {
        await this.repository.replaceAutomaticCatalogMappings(item.id, resolution.variantIds.map((variantId) => ({ variantId, source: resolution.source!, confidence: resolution.confidence })));
      }
    }
    const ads: TikTokMappingAd[] = dataset.tiktokAdvertisers.flatMap((advertiser) => advertiser.ads);
    for (const ad of ads) {
      const resolution = resolveTikTokAd(ad, variants, catalogItems, catalogResolutions, hosts);
      await this.repository.replaceAutomaticAdMappings(ad.id, resolution.mappings.map((mapping) => ({ ...mapping, evidenceJson: mapping.evidence })));
      await this.repository.updateAdTargetScope(ad.id, resolution.targetScope, resolution.confidence, resolution.evidence);
    }
    return { catalogs: catalogItems.length, ads: ads.length };
  }

  async setManualAdMapping(storeId: string, externalAdId: string, productId: string, variantId: string | null) {
    const context = await this.authService.getApiContext(storeId);
    const dataset = await this.repository.getMappingDataset(storeId, context.selectedCatalogIds, context.selectedAdvertiserIds);
    if (!dataset?.tiktokAdvertisers.some((advertiser) => advertiser.ads.some((ad) => ad.tiktokAdId === externalAdId))) {
      throw new AppError('TikTok ad not found in selected advertisers', 404, 'TIKTOK_AD_NOT_FOUND');
    }
    const mapping = await this.repository.replaceManualAdMapping(storeId, externalAdId, productId, variantId);
    if (!mapping) throw new AppError('TikTok ad/product/variant mapping is invalid', 400, 'TIKTOK_MAPPING_INVALID');
    return mapping;
  }

  async setManualCatalogMapping(storeId: string, catalogItemId: string, variantId: string) {
    const context = await this.authService.getApiContext(storeId);
    const dataset = await this.repository.getMappingDataset(storeId, context.selectedCatalogIds, context.selectedAdvertiserIds);
    if (!dataset?.tiktokCatalogs.some((catalog) => catalog.items.some((item) => item.id === catalogItemId))) {
      throw new AppError('TikTok catalog item not found in selected catalogs', 404, 'TIKTOK_CATALOG_ITEM_NOT_FOUND');
    }
    const mapping = await this.repository.replaceManualCatalogMapping(storeId, catalogItemId, variantId);
    if (!mapping) throw new AppError('TikTok catalog mapping is invalid', 400, 'TIKTOK_MAPPING_INVALID');
    return mapping;
  }

  private async requireConfiguredContext(storeId: string): Promise<TikTokApiContext> {
    const context = await this.authService.getApiContext(storeId);
    if (context.selectedAdvertiserIds.length === 0) throw new AppError('Select at least one TikTok advertiser first', 409, 'TIKTOK_ADVERTISERS_NOT_CONFIGURED');
    return context;
  }

  private toAdvertiserAsset(record: TikTokObject) {
    const advertiserId = stringValue(record, 'advertiser_id', 'id');
    if (!advertiserId) throw new AppError('TikTok returned an advertiser without an ID', 502, 'TIKTOK_BAD_RESPONSE');
    return {
      advertiserId,
      name: stringValue(record, 'name', 'advertiser_name') ?? advertiserId,
      status: stringValue(record, 'status'), currency: stringValue(record, 'currency'), timezone: stringValue(record, 'timezone', 'timezone_name'),
      countryCode: stringValue(record, 'country_code', 'country'), industry: stringValue(record, 'industry'), company: stringValue(record, 'company'), balance: numberValue(record, 'balance'),
    };
  }

  private toCatalogAsset(record: TikTokObject) {
    const tiktokCatalogId = stringValue(record, 'catalog_id', 'id');
    if (!tiktokCatalogId) throw new AppError('TikTok returned a catalog without an ID', 502, 'TIKTOK_BAD_RESPONSE');
    return {
      tiktokCatalogId,
      name: stringValue(record, 'catalog_name', 'name') ?? tiktokCatalogId,
      businessCenterId: stringValue(record, 'business_center_id', 'bc_id'), catalogType: stringValue(record, 'catalog_type'), vertical: stringValue(record, 'vertical'),
      region: stringValue(record, 'region'), currency: stringValue(record, 'currency'), productCount: numberValue(record, 'product_count'),
    };
  }
}
