import { AppError } from '../../errors/app-error.js';
import { integrationService, type IntegrationService } from '../integrations/integration.service.js';
import { TikTokAdsRepository } from './ads/tiktok-ads.repository.js';
import { TikTokAdsService } from './ads/tiktok-ads.service.js';
import { TikTokCatalogRepository } from './catalog/tiktok-catalog.repository.js';
import { TikTokCatalogService } from './catalog/tiktok-catalog.service.js';
import {
  DEFAULT_TIKTOK_INSIGHTS_LOOKBACK_DAYS,
  TikTokInsightsService,
} from './insights/tiktok-insights.service.js';
import { TikTokInsightsRepository } from './insights/tiktok-insights.repository.js';
import { tiktokMappingService, type TikTokMappingService } from './mapping/tiktok-mapping.service.js';
import { TikTokApiService } from './shared/tiktok-api.service.js';
import { TikTokAuthService } from './shared/tiktok-auth.service.js';
import { TikTokRepository } from './tiktok.repository.js';
import type { TikTokApiContext, TikTokObject } from './tiktok.types.js';
import { asNumber, asString, toJsonSafe } from './tiktok.utils.js';

const ADS_HIERARCHY_RESOURCE = 'AdsHierarchy';
const CATALOG_RESOURCE = 'ProductCatalogs';
const INSIGHTS_RESOURCE = 'AdInsightsDaily';

function value(record: TikTokObject, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}
function stringValue(record: TikTokObject, ...keys: string[]) { return asString(value(record, ...keys)); }
function numberValue(record: TikTokObject, ...keys: string[]) { return asNumber(value(record, ...keys)); }

export class TikTokService {
  constructor(
    private readonly repository: TikTokRepository,
    private readonly authService: TikTokAuthService,
    private readonly apiService: TikTokApiService,
    private readonly adsService: TikTokAdsService,
    private readonly integrationService: IntegrationService,
    private readonly catalogService: TikTokCatalogService,
    private readonly insightsService: TikTokInsightsService,
    private readonly mappingService: TikTokMappingService,
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
      : authorized.map((record) => ({
          advertiserId: record.advertiser_id,
          name: record.advertiser_name ?? record.advertiser_id,
          status: null,
          currency: null,
          timezone: null,
          countryCode: null,
        }));
    const catalogs = await this.catalogService.discoverAccessibleCatalogs(
      context,
      businessCenters.map((item) => item.bc_id),
    );

    return {
      businessCenters: businessCenters.map((item) => ({
        id: item.bc_id,
        name: item.name ?? item.bc_id,
        status: item.status ?? null,
        currency: item.currency ?? null,
        timezone: item.timezone ?? null,
      })),
      advertisers,
      catalogs,
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

    const businessCenterId = input.businessCenterId ?? null;
    if (businessCenterId) {
      const centers = await this.apiService.listBusinessCenters(context);
      if (!centers.some((center) => center.bc_id === businessCenterId)) {
        throw new AppError('Selected TikTok Business Center is not accessible', 400, 'TIKTOK_BUSINESS_CENTER_NOT_ACCESSIBLE');
      }
    }

    const advertiserRecords = await this.apiService.getAdvertiserInfo(context, input.advertiserIds);
    const byId = new Map(advertiserRecords.map((record) => [stringValue(record, 'advertiser_id'), record]));
    for (const advertiserId of input.advertiserIds) {
      const record = byId.get(advertiserId) ?? {
        advertiser_id: advertiserId,
        name: authorized.find((item) => item.advertiser_id === advertiserId)?.advertiser_name ?? advertiserId,
      };
      await this.repository.upsertAdvertiser({
        storeId,
        connectionId: context.connectionId,
        ...this.toAdvertiserAsset(record),
        raw: record,
      });
    }
    await this.repository.configureAssets(context.connectionId, businessCenterId, input.advertiserIds);
    return this.getStatus(storeId);
  }

  async configureCatalogs(storeId: string, catalogIds: string[]) {
    const context = await this.authService.getApiContext(storeId);
    await this.catalogService.configureCatalogs(storeId, context, catalogIds);
    return this.getStatus(storeId);
  }

  listCampaigns(storeId: string, input: { page: number; limit: number; advertiserId?: string; status?: string }) {
    return this.adsService.listCampaigns(storeId, input);
  }

  listAdGroups(storeId: string, input: { page: number; limit: number; campaignId?: string; status?: string }) {
    return this.adsService.listAdGroups(storeId, input);
  }

  listAds(storeId: string, input: { page: number; limit: number; campaignId?: string; adGroupId?: string; status?: string }) {
    return this.adsService.listAds(storeId, input);
  }

  getAd(storeId: string, externalAdId: string) {
    return this.adsService.getAd(storeId, externalAdId);
  }

  listCatalogs(storeId: string) {
    return this.catalogService.listCatalogs(storeId);
  }

  listCatalogItems(storeId: string, catalogId: string, page: number, limit: number) {
    return this.catalogService.listCatalogItems(storeId, catalogId, page, limit);
  }

  listInsights(storeId: string, input: {
    page: number;
    limit: number;
    from: string;
    to: string;
    advertiserId?: string;
    campaignId?: string;
    adGroupId?: string;
    adId?: string;
  }) {
    return this.insightsService.listInsights(storeId, input);
  }

  async syncAdsHierarchy(storeId: string) {
    const context = await this.requireConfiguredContext(storeId);
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'TIKTOK',
      connectionId: context.connectionId,
      resourceType: ADS_HIERARCHY_RESOURCE,
      mode: 'FULL',
      apiVersion: context.apiVersion,
    });
    try {
      const result = await this.adsService.syncSelectedAdvertisers(storeId, context);
      await this.integrationService.recordExternalPayload({
        provider: 'TIKTOK',
        resourceType: ADS_HIERARCHY_RESOURCE,
        apiVersion: context.apiVersion,
        payload: toJsonSafe({ advertiserIds: context.selectedAdvertiserIds, ...result }),
        syncRunId: syncRun.id,
      });
      await this.integrationService.completeSyncRun(syncRun.id, result);
      await this.repository.markConnectionSynced(context.connectionId);
      await this.mappingService.resolveMappings(storeId);
      return { syncRunId: syncRun.id, ...result };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error);
      if (error instanceof AppError && error.code === 'TIKTOK_REAUTH_REQUIRED') {
        await this.repository.markConnectionReauthRequired(context.connectionId);
      }
      throw error;
    }
  }

  async syncCatalogs(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'TIKTOK',
      connectionId: context.connectionId,
      resourceType: CATALOG_RESOURCE,
      mode: 'FULL',
      apiVersion: context.apiVersion,
    });
    try {
      const result = await this.catalogService.syncSelectedCatalogs(storeId, context);
      await this.integrationService.recordExternalPayload({
        provider: 'TIKTOK',
        resourceType: CATALOG_RESOURCE,
        apiVersion: context.apiVersion,
        payload: toJsonSafe({ selectedCatalogIds: context.selectedCatalogIds, ...result }),
        syncRunId: syncRun.id,
      });
      await this.integrationService.completeSyncRun(syncRun.id, result);
      await this.mappingService.resolveMappings(storeId);
      return { syncRunId: syncRun.id, ...result };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error);
      throw error;
    }
  }

  async syncInsights(storeId: string, lookbackDays = DEFAULT_TIKTOK_INSIGHTS_LOOKBACK_DAYS) {
    const context = await this.requireConfiguredContext(storeId);
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'TIKTOK',
      connectionId: context.connectionId,
      resourceType: INSIGHTS_RESOURCE,
      mode: 'INCREMENTAL',
      apiVersion: context.apiVersion,
    });
    try {
      const result = await this.insightsService.syncSelectedAdvertisers(storeId, context, lookbackDays);
      await this.integrationService.completeSyncRun(syncRun.id, result);
      await this.repository.markConnectionSynced(context.connectionId);
      return { syncRunId: syncRun.id, ...result };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error);
      throw error;
    }
  }

  private async requireConfiguredContext(storeId: string): Promise<TikTokApiContext> {
    const context = await this.authService.getApiContext(storeId);
    if (context.selectedAdvertiserIds.length === 0) {
      throw new AppError('Select at least one TikTok advertiser first', 409, 'TIKTOK_ADVERTISERS_NOT_CONFIGURED');
    }
    return context;
  }

  private toAdvertiserAsset(record: TikTokObject) {
    const advertiserId = stringValue(record, 'advertiser_id', 'id');
    if (!advertiserId) throw new AppError('TikTok returned an advertiser without an ID', 502, 'TIKTOK_BAD_RESPONSE');
    return {
      advertiserId,
      name: stringValue(record, 'name', 'advertiser_name') ?? advertiserId,
      status: stringValue(record, 'status'),
      currency: stringValue(record, 'currency'),
      timezone: stringValue(record, 'timezone', 'timezone_name'),
      countryCode: stringValue(record, 'country_code', 'country'),
      industry: stringValue(record, 'industry'),
      company: stringValue(record, 'company'),
      balance: numberValue(record, 'balance'),
    };
  }
}

const tiktokRepository = new TikTokRepository();
const tiktokApiService = new TikTokApiService();
const tiktokAdsRepository = new TikTokAdsRepository();
const tiktokAdsService = new TikTokAdsService(tiktokAdsRepository, tiktokApiService);
const tiktokCatalogService = new TikTokCatalogService(
  new TikTokCatalogRepository(),
  tiktokRepository,
  tiktokApiService,
);
const tiktokInsightsService = new TikTokInsightsService(
  new TikTokInsightsRepository(),
  tiktokAdsRepository,
  tiktokApiService,
);

export const tiktokService = new TikTokService(
  tiktokRepository,
  new TikTokAuthService(tiktokRepository, tiktokApiService),
  tiktokApiService,
  tiktokAdsService,
  integrationService,
  tiktokCatalogService,
  tiktokInsightsService,
  tiktokMappingService,
);
