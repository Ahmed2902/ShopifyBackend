import { AppError } from '../../errors/app-error.js';
import type { IntegrationService } from '../integrations/integration.service.js';
import type { MetaAdsRepository } from './ads/meta-ads.repository.js';
import type { MetaAdsService } from './ads/meta-ads.service.js';
import type { MetaCatalogRepository } from './catalog/meta-catalog.repository.js';
import type { MetaCatalogService } from './catalog/meta-catalog.service.js';
import type { MetaInsightsRepository } from './insights/meta-insights.repository.js';
import type { MetaInsightsService } from './insights/meta-insights.service.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaApiService } from './shared/meta-api.service.js';
import type { MetaAuthService } from './shared/meta-auth.service.js';
import { normalizeMetaAdAccountId } from './meta.utils.js';

const ADS_HIERARCHY_RESOURCE = 'AdsHierarchy';
const CATALOG_RESOURCE = 'ProductCatalogs';
const INSIGHTS_RESOURCE = 'AdInsightsDaily';

function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current) =>
      typeof current === 'bigint' ? current.toString() : current,
    ),
  ) as unknown;
}

export class MetaService {
  constructor(
    private readonly repository: MetaRepository,
    private readonly authService: MetaAuthService,
    private readonly apiService: MetaApiService,
    private readonly adsService: MetaAdsService,
    private readonly adsRepository: MetaAdsRepository,
    private readonly integrationService: IntegrationService,
    private readonly catalogService: MetaCatalogService,
    private readonly catalogRepository: MetaCatalogRepository,
    private readonly insightsService: MetaInsightsService,
    private readonly insightsRepository: MetaInsightsRepository,
  ) {}

  startOAuthInstall(userId: string, storeId: string) {
    return this.authService.startInstall(userId, storeId);
  }

  completeOAuthInstall(code: string, state: string) {
    return this.authService.completeInstall(code, state);
  }

  async discoverAssets(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const businesses = context.scopes.includes('business_management')
      ? await this.apiService.listBusinesses(context)
      : [];
    const [adAccounts, catalogs] = await Promise.all([
      this.apiService.listAdAccounts(context),
      context.scopes.includes('business_management')
        ? this.catalogService.discoverOwnedCatalogs(
            context,
            businesses.map((business) => business.id),
          )
        : Promise.resolve([]),
    ]);

    return {
      businesses,
      adAccounts: adAccounts.map((account) => ({
        id: account.id,
        accountId: account.accountId,
        name: account.name,
        accountStatus: account.accountStatus,
        currency: account.currency,
        timezoneName: account.timezoneName,
        timezoneId: account.timezoneId,
        timezoneOffsetHoursUtc: account.timezoneOffsetHoursUtc,
        business: account.business,
      })),
      catalogs: catalogs.map((catalog) => ({
        id: catalog.id,
        name: catalog.name,
        businessId: catalog.businessId,
        ownerBusinessId: catalog.ownerBusinessId,
        vertical: catalog.vertical,
        productCount: catalog.productCount,
        feedCount: catalog.feedCount,
      })),
      permissions: {
        granted: context.scopes,
        businessDiscoveryAvailable: context.scopes.includes('business_management'),
        catalogDiscoveryAvailable: context.scopes.includes('business_management'),
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
    const discoveredIds = new Set(selected.map((account) => account.id));
    const missing = Array.from(requested).filter((id) => !discoveredIds.has(id));
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
      selectedAdAccounts: selected.map((account) => ({
        id: account.id,
        accountId: account.accountId,
        name: account.name,
        currency: account.currency,
        timezoneName: account.timezoneName,
      })),
    };
  }

  async configureCatalogs(storeId: string, catalogIds: string[]) {
    const context = await this.authService.getApiContext(storeId);
    if (!context.scopes.includes('business_management')) {
      throw new AppError(
        'Meta business_management permission is required to discover commerce catalogs',
        403,
        'META_BUSINESS_PERMISSION_REQUIRED',
      );
    }
    const businesses = await this.apiService.listBusinesses(context);
    const businessIds = context.metaBusinessId
      ? [context.metaBusinessId]
      : businesses.map((business) => business.id);
    const catalogs = await this.catalogService.discoverOwnedCatalogs(context, businessIds);
    const selected = await this.catalogService.configureCatalogs(context, catalogs, catalogIds);
    return { storeId, selectedCatalogIds: selected.map((catalog) => catalog.id), catalogs: selected };
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
      return { syncRunId: syncRun.id, status: 'SUCCEEDED' as const, resourceType: CATALOG_RESOURCE, ...result };
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

  async listAdAccounts(storeId: string) {
    return jsonSafe(await this.adsRepository.listAdAccounts(storeId));
  }

  async listCampaigns(
    storeId: string,
    input: { adAccountId?: string; status?: string; page: number; limit: number },
  ) {
    return jsonSafe(await this.adsRepository.listCampaigns(storeId, input));
  }

  async listAdSets(
    storeId: string,
    input: { campaignId?: string; status?: string; page: number; limit: number },
  ) {
    return jsonSafe(await this.adsRepository.listAdSets(storeId, input));
  }

  async listAds(
    storeId: string,
    input: { campaignId?: string; adSetId?: string; status?: string; page: number; limit: number },
  ) {
    return jsonSafe(await this.adsRepository.listAds(storeId, input));
  }

  async getAd(storeId: string, metaAdId: string) {
    const ad = await this.adsRepository.getAd(storeId, metaAdId);
    if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
    return jsonSafe(ad);
  }

  async listCatalogs(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    return jsonSafe(await this.catalogRepository.listCatalogs(storeId, context.selectedCatalogIds));
  }

  async listCatalogItems(storeId: string, catalogId: string, page: number, limit: number) {
    await this.catalogRepository.requireSelectedCatalog(storeId, catalogId);
    return jsonSafe(await this.catalogRepository.listItems(storeId, catalogId, page, limit));
  }

  async listInsights(
    storeId: string,
    input: { from: string; to: string; adId?: string; page: number; limit: number },
  ) {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    return jsonSafe(
      await this.insightsRepository.listDaily(storeId, {
        from,
        to,
        adId: input.adId,
        page: input.page,
        limit: input.limit,
      }),
    );
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
    const catalogs = await this.catalogRepository.listCatalogs(storeId, connection.selectedCatalogIds);
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
      catalogs: jsonSafe(catalogs),
    };
  }
}
