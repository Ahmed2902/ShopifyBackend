import { AppError } from '../../errors/app-error.js';
import { integrationService, type IntegrationService } from '../integrations/integration.service.js';
import { MetaAdsRepository } from './ads/meta-ads.repository.js';
import { MetaAdsService } from './ads/meta-ads.service.js';
import { MetaCatalogRepository } from './catalog/meta-catalog.repository.js';
import { MetaCatalogService } from './catalog/meta-catalog.service.js';
import { MetaInsightsRepository } from './insights/meta-insights.repository.js';
import { MetaInsightsService } from './insights/meta-insights.service.js';
import { MetaRepository } from './meta.repository.js';
import { MetaApiService } from './shared/meta-api.service.js';
import { MetaAuthService } from './shared/meta-auth.service.js';
import { normalizeMetaAdAccountId } from './meta.utils.js';

const ADS_HIERARCHY_RESOURCE = 'AdsHierarchy';
const CATALOG_RESOURCE = 'ProductCatalogs';
const INSIGHTS_RESOURCE = 'AdInsightsDaily';

export class MetaService {
  constructor(
    private readonly repository: MetaRepository,
    private readonly authService: MetaAuthService,
    private readonly apiService: MetaApiService,
    private readonly adsService: MetaAdsService,
    private readonly integrationService: IntegrationService,
    private readonly catalogService: MetaCatalogService,
    private readonly insightsService: MetaInsightsService,
  ) {}

  startOAuthInstall(userId: string, storeId: string) {
    return this.authService.startInstall(userId, storeId);
  }

  completeOAuthInstall(code: string, state: string) {
    return this.authService.completeInstall(code, state);
  }

  async discoverAssets(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const businessDiscoveryAvailable = context.scopes.includes('business_management');
    const catalogDiscoveryAvailable =
      businessDiscoveryAvailable && context.scopes.includes('catalog_management');
    const businesses = businessDiscoveryAvailable ? await this.apiService.listBusinesses(context) : [];
    const [adAccounts, catalogs] = await Promise.all([
      this.apiService.listAdAccounts(context),
      catalogDiscoveryAvailable
        ? this.catalogService.discoverOwnedCatalogs(
            context,
            businesses.map((business) => business.id),
          )
        : Promise.resolve([]),
    ]);

    return {
      businesses,
      adAccounts: adAccounts.map(
        ({
          id,
          accountId,
          name,
          accountStatus,
          currency,
          timezoneName,
          timezoneId,
          timezoneOffsetHoursUtc,
          business,
        }) => ({
          id,
          accountId,
          name,
          accountStatus,
          currency,
          timezoneName,
          timezoneId,
          timezoneOffsetHoursUtc,
          business,
        }),
      ),
      catalogs: catalogs.map(
        ({ id, name, businessId, ownerBusinessId, vertical, productCount, feedCount }) => ({
          id,
          name,
          businessId,
          ownerBusinessId,
          vertical,
          productCount,
          feedCount,
        }),
      ),
      permissions: {
        granted: context.scopes,
        businessDiscoveryAvailable,
        catalogDiscoveryAvailable,
      },
    };
  }

  async configureAssets(
    storeId: string,
    input: { metaBusinessId?: string | null; adAccountIds: string[] },
  ) {
    const context = await this.authService.getApiContext(storeId);
    const [businesses, adAccounts] = await Promise.all([
      context.scopes.includes('business_management')
        ? this.apiService.listBusinesses(context)
        : Promise.resolve([]),
      this.apiService.listAdAccounts(context),
    ]);

    const businessId = input.metaBusinessId ?? null;
    if (businessId && !businesses.some((business) => business.id === businessId)) {
      throw new AppError(
        'Selected Meta business is not accessible to this connection',
        400,
        'META_BUSINESS_NOT_ACCESSIBLE',
      );
    }

    const requested = new Set(input.adAccountIds.map(normalizeMetaAdAccountId));
    const selected = adAccounts.filter((account) => requested.has(account.id));
    const selectedIds = new Set(selected.map((account) => account.id));
    const missing = [...requested].filter((id) => !selectedIds.has(id));
    if (missing.length > 0) {
      throw new AppError(
        `Selected Meta ad accounts are not accessible: ${missing.join(', ')}`,
        400,
        'META_AD_ACCOUNT_NOT_ACCESSIBLE',
      );
    }

    await this.repository.configureAssets({
      connectionId: context.connectionId,
      storeId,
      metaBusinessId: businessId,
      adAccounts: selected,
    });

    return {
      storeId,
      metaBusinessId: businessId,
      selectedAdAccountIds: selected.map((account) => account.id),
      selectedAdAccounts: selected.map(({ id, accountId, name, currency, timezoneName }) => ({
        id,
        accountId,
        name,
        currency,
        timezoneName,
      })),
    };
  }

  async configureCatalogs(storeId: string, catalogIds: string[]) {
    const context = await this.authService.getApiContext(storeId);
    if (catalogIds.length === 0) {
      const selected = await this.catalogService.configureCatalogs(context, [], []);
      return { storeId, selectedCatalogIds: [], catalogs: selected };
    }
    if (!context.scopes.includes('business_management')) {
      throw new AppError(
        'Meta business_management permission is required to discover commerce catalogs',
        403,
        'META_BUSINESS_PERMISSION_REQUIRED',
      );
    }
    if (!context.scopes.includes('catalog_management')) {
      throw new AppError(
        'Meta catalog_management permission is required to discover commerce catalogs',
        403,
        'META_CATALOG_PERMISSION_REQUIRED',
      );
    }

    const businesses = await this.apiService.listBusinesses(context);
    const catalogs = await this.catalogService.discoverOwnedCatalogs(
      context,
      context.metaBusinessId ? [context.metaBusinessId] : businesses.map((business) => business.id),
    );
    const selected = await this.catalogService.configureCatalogs(context, catalogs, catalogIds);
    return {
      storeId,
      selectedCatalogIds: selected.map((catalog) => catalog.id),
      catalogs: selected,
    };
  }

  async syncAdsHierarchy(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    if (context.selectedAdAccountIds.length === 0) {
      throw new AppError(
        'Select at least one Meta ad account before syncing ads',
        409,
        'META_ASSETS_NOT_CONFIGURED',
      );
    }

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'META',
      connectionId: context.connectionId,
      resourceType: ADS_HIERARCHY_RESOURCE,
      mode: 'MANUAL',
      apiVersion: context.apiVersion,
    });

    try {
      const breakdown = {
        adAccounts: 0,
        campaigns: 0,
        adSets: 0,
        creatives: 0,
        ads: 0,
        softDeletedCampaigns: 0,
        softDeletedAdSets: 0,
        softDeletedCreatives: 0,
        softDeletedAds: 0,
      };
      let recordsRead = 0;
      let recordsWritten = 0;

      for (const accountId of context.selectedAdAccountIds) {
        const result = await this.adsService.syncSelectedAccount(context, accountId);
        recordsRead += result.recordsRead;
        recordsWritten += result.recordsWritten;
        for (const key of Object.keys(breakdown) as Array<keyof typeof breakdown>) {
          breakdown[key] += result.breakdown[key];
        }
      }

      await this.repository.markConnectionSynced(context.connectionId);
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead, recordsWritten });
      await this.integrationService.recordExternalPayload({
        provider: 'META',
        resourceType: 'AdsHierarchySyncSummary',
        apiVersion: context.apiVersion,
        payload: { selectedAdAccountIds: context.selectedAdAccountIds, breakdown },
        syncRunId: syncRun.id,
      });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: ADS_HIERARCHY_RESOURCE,
        recordsRead,
        recordsWritten,
        breakdown,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async syncCatalogs(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    if (context.selectedCatalogIds.length === 0) {
      throw new AppError(
        'Select at least one Meta commerce catalog before syncing catalog items',
        409,
        'META_CATALOGS_NOT_CONFIGURED',
      );
    }

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'META',
      connectionId: context.connectionId,
      resourceType: CATALOG_RESOURCE,
      mode: 'MANUAL',
      apiVersion: context.apiVersion,
    });
    try {
      const result = await this.catalogService.syncSelectedCatalogs(
        context,
        context.selectedCatalogIds,
      );
      await this.integrationService.completeSyncRun(syncRun.id, result);
      await this.integrationService.recordExternalPayload({
        provider: 'META',
        resourceType: 'ProductCatalogSyncSummary',
        apiVersion: context.apiVersion,
        payload: result.breakdown,
        syncRunId: syncRun.id,
      });
      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: CATALOG_RESOURCE,
        ...result,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async syncInsights(storeId: string, lookbackDays?: number) {
    const context = await this.authService.getApiContext(storeId);
    if (context.selectedAdAccountIds.length === 0) {
      throw new AppError(
        'Select at least one Meta ad account before syncing insights',
        409,
        'META_ASSETS_NOT_CONFIGURED',
      );
    }

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'META',
      connectionId: context.connectionId,
      resourceType: INSIGHTS_RESOURCE,
      mode: lookbackDays ? 'MANUAL' : 'INCREMENTAL',
      apiVersion: context.apiVersion,
    });
    try {
      let recordsRead = 0;
      let recordsWritten = 0;
      let staleRowsDeleted = 0;
      const accounts: Array<{ accountId: string; lookbackDays: number; initialBackfill: boolean }> = [];

      for (const accountId of context.selectedAdAccountIds) {
        const result = await this.insightsService.syncAccount(context, accountId, lookbackDays);
        recordsRead += result.recordsRead;
        recordsWritten += result.recordsWritten;
        staleRowsDeleted += result.staleRowsDeleted;
        accounts.push({
          accountId,
          lookbackDays: result.lookbackDays,
          initialBackfill: result.initialBackfill,
        });
      }

      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead, recordsWritten });
      await this.integrationService.recordExternalPayload({
        provider: 'META',
        resourceType: 'AdInsightsSyncSummary',
        apiVersion: context.apiVersion,
        payload: {
          accounts,
          staleRowsDeleted,
          actionReportTime: 'impression',
          attributionMode: 'UNIFIED_ADSET_SETTING',
        },
        syncRunId: syncRun.id,
      });
      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: INSIGHTS_RESOURCE,
        recordsRead,
        recordsWritten,
        staleRowsDeleted,
        accounts,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  listAdAccounts(storeId: string) {
    return this.adsService.listAdAccounts(storeId);
  }

  listCampaigns(
    storeId: string,
    input: { adAccountId?: string; status?: string; page: number; limit: number },
  ) {
    return this.adsService.listCampaigns(storeId, input);
  }

  listAdSets(
    storeId: string,
    input: { campaignId?: string; status?: string; page: number; limit: number },
  ) {
    return this.adsService.listAdSets(storeId, input);
  }

  listAds(
    storeId: string,
    input: { campaignId?: string; adSetId?: string; status?: string; page: number; limit: number },
  ) {
    return this.adsService.listAds(storeId, input);
  }

  getAd(storeId: string, metaAdId: string) {
    return this.adsService.getAd(storeId, metaAdId);
  }

  async listCatalogs(storeId: string) {
    const connection = await this.repository.getStatus(storeId);
    return this.catalogService.listCatalogs(storeId, connection?.selectedCatalogIds ?? []);
  }

  listCatalogItems(storeId: string, catalogId: string, page: number, limit: number) {
    return this.catalogService.listItems(storeId, catalogId, page, limit);
  }

  listInsights(
    storeId: string,
    input: { from: string; to: string; adId?: string; page: number; limit: number },
  ) {
    return this.insightsService.listDaily(storeId, input);
  }

  async getStatus(storeId: string) {
    const connection = await this.repository.getStatus(storeId);
    if (!connection) {
      return {
        connected: false,
        status: 'DISCONNECTED' as const,
        configured: false,
        connection: null,
        adAccounts: [],
        catalogs: [],
      };
    }

    const selected = new Set(connection.selectedAdAccountIds);
    return {
      connected: connection.status === 'ACTIVE',
      status: connection.status,
      configured: connection.selectedAdAccountIds.length > 0,
      connection: {
        id: connection.id,
        metaUserId: connection.metaUserId,
        metaBusinessId: connection.metaBusinessId,
        scopes: connection.scopes,
        apiVersion: connection.apiVersion,
        tokenExpiresAt: connection.tokenExpiresAt,
        lastSyncedAt: connection.lastSyncedAt,
      },
      adAccounts: connection.adAccounts.filter((account) => selected.has(account.metaAccountId)),
      catalogs: await this.catalogService.listCatalogs(storeId, connection.selectedCatalogIds),
    };
  }
}

const metaRepository = new MetaRepository();
const metaApiService = new MetaApiService(metaRepository);
const metaAdsService = new MetaAdsService(new MetaAdsRepository(), metaApiService);
const metaCatalogService = new MetaCatalogService(new MetaCatalogRepository(), metaApiService);
const metaInsightsService = new MetaInsightsService(new MetaInsightsRepository(), metaApiService);

export const metaService = new MetaService(
  metaRepository,
  new MetaAuthService(metaRepository, metaApiService),
  metaApiService,
  metaAdsService,
  integrationService,
  metaCatalogService,
  metaInsightsService,
);