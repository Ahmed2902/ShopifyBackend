import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { MetaAdsService } from '../../../src/modules/meta/ads/meta-ads.service.js';
import type { MetaCatalogService } from '../../../src/modules/meta/catalog/meta-catalog.service.js';
import type { MetaInsightsService } from '../../../src/modules/meta/insights/meta-insights.service.js';
import type { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { MetaService } from '../../../src/modules/meta/meta.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';
import type { MetaAuthService } from '../../../src/modules/meta/shared/meta-auth.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const accounts = [
  {
    id: 'act_101', accountId: '101', name: 'Primary', accountStatus: 1, currency: 'USD',
    timezoneName: 'America/New_York', timezoneId: 1, timezoneOffsetHoursUtc: -4,
    amountSpentMinor: 1000n, balanceMinor: 0n, spendCapMinor: null,
    business: { id: 'biz_1', name: 'Store Business' }, raw: { id: 'act_101' },
  },
  {
    id: 'act_202', accountId: '202', name: 'Secondary', accountStatus: 1, currency: 'USD',
    timezoneName: 'America/New_York', timezoneId: 1, timezoneOffsetHoursUtc: -4,
    amountSpentMinor: 500n, balanceMinor: 0n, spendCapMinor: null,
    business: { id: 'biz_1', name: 'Store Business' }, raw: { id: 'act_202' },
  },
];
const catalogs = [
  {
    id: 'cat_1', name: 'Store Catalog', businessId: 'biz_1', ownerBusinessId: 'biz_1',
    vertical: 'commerce', productCount: 20, feedCount: 1, raw: { id: 'cat_1' },
  },
];

function build(options?: {
  selectedAdAccountIds?: string[];
  selectedCatalogIds?: string[];
  syncFails?: boolean;
}) {
  const selectedAdAccountIds = options?.selectedAdAccountIds ?? ['act_101'];
  const selectedCatalogIds = options?.selectedCatalogIds ?? [];
  const repository = {
    configureAssets: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(),
    markConnectionSynced: vi.fn().mockResolvedValue(undefined),
  } as unknown as MetaRepository;
  const authService = {
    getApiContext: vi.fn().mockResolvedValue({
      storeId,
      connectionId,
      accessToken: 'token',
      apiVersion: 'v26.0',
      scopes: ['ads_read', 'business_management', 'catalog_management'],
      metaBusinessId: 'biz_1',
      selectedAdAccountIds,
      selectedCatalogIds,
    }),
  } as unknown as MetaAuthService;
  const apiService = {
    listBusinesses: vi.fn().mockResolvedValue([{ id: 'biz_1', name: 'Store Business' }]),
    listAdAccounts: vi.fn().mockResolvedValue(accounts),
  } as unknown as MetaApiService;
  const adsService = {
    syncSelectedAccount: options?.syncFails
      ? vi.fn().mockRejectedValue(new Error('provider failed'))
      : vi.fn().mockResolvedValue({
          recordsRead: 5,
          recordsWritten: 6,
          breakdown: {
            adAccounts: 1, campaigns: 1, adSets: 1, creatives: 1, ads: 1,
            softDeletedCampaigns: 1, softDeletedAdSets: 0,
            softDeletedCreatives: 0, softDeletedAds: 0,
          },
        }),
  } as unknown as MetaAdsService;
  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;
  const catalogService = {
    discoverOwnedCatalogs: vi.fn().mockResolvedValue(catalogs),
    configureCatalogs: vi.fn().mockResolvedValue(catalogs),
    syncSelectedCatalogs: vi.fn().mockResolvedValue({
      recordsRead: 21,
      recordsWritten: 22,
      breakdown: { catalogs: 1, items: 20, softDeletedItems: 1, byCatalog: [] },
    }),
  } as unknown as MetaCatalogService;
  const insightsService = {
    syncAccount: vi.fn().mockResolvedValue({
      recordsRead: 12,
      recordsWritten: 13,
      lookbackDays: 90,
      initialBackfill: true,
      staleRowsDeleted: 1,
      actionReportTime: 'impression',
      attributionMode: 'UNIFIED_ADSET_SETTING',
    }),
  } as unknown as MetaInsightsService;

  return {
    repository,
    authService,
    apiService,
    adsService,
    integrationService,
    catalogService,
    insightsService,
    service: new MetaService(
      repository,
      authService,
      apiService,
      adsService,
      integrationService,
      catalogService,
      insightsService,
    ),
  };
}

describe('MetaService asset configuration', () => {
  it('discovers businesses, ad accounts and commerce catalogs without persisting them', async () => {
    const { repository, catalogService, service } = build();
    const result = await service.discoverAssets(storeId);

    expect(result.businesses).toEqual([{ id: 'biz_1', name: 'Store Business' }]);
    expect(result.adAccounts).toHaveLength(2);
    expect(result.catalogs).toHaveLength(1);
    expect(catalogService.discoverOwnedCatalogs).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId }),
      ['biz_1'],
    );
    expect(repository.configureAssets).not.toHaveBeenCalled();
  });

  it('normalizes and persists only explicitly selected accessible accounts', async () => {
    const { repository, service } = build();
    const result = await service.configureAssets(storeId, {
      metaBusinessId: 'biz_1',
      adAccountIds: ['101'],
    });

    expect(repository.configureAssets).toHaveBeenCalledWith({
      connectionId,
      storeId,
      metaBusinessId: 'biz_1',
      adAccounts: [accounts[0]],
    });
    expect(result.selectedAdAccountIds).toEqual(['act_101']);
  });

  it('rejects an ad account that the connected user cannot access', async () => {
    const { repository, service } = build();
    await expect(
      service.configureAssets(storeId, { metaBusinessId: 'biz_1', adAccountIds: ['999'] }),
    ).rejects.toMatchObject({ code: 'META_AD_ACCOUNT_NOT_ACCESSIBLE' });
    expect(repository.configureAssets).not.toHaveBeenCalled();
  });

  it('configures only accessible selected catalogs', async () => {
    const { catalogService, service } = build();
    const result = await service.configureCatalogs(storeId, ['cat_1']);
    expect(catalogService.configureCatalogs).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId }),
      catalogs,
      ['cat_1'],
    );
    expect(result.selectedCatalogIds).toEqual(['cat_1']);
  });
});

describe('MetaService ads hierarchy sync', () => {
  it('syncs each selected account, completes one SyncRun and records a summary', async () => {
    const { repository, adsService, integrationService, service } = build({
      selectedAdAccountIds: ['act_101', 'act_202'],
    });
    const result = await service.syncAdsHierarchy(storeId);

    expect(adsService.syncSelectedAccount).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'SUCCEEDED', resourceType: 'AdsHierarchy', recordsRead: 10, recordsWritten: 12,
    });
    expect(repository.markConnectionSynced).toHaveBeenCalledWith(connectionId);
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 10,
      recordsWritten: 12,
    });
  });

  it('fails the SyncRun when a provider account sync fails', async () => {
    const { integrationService, service } = build({ syncFails: true });
    await expect(service.syncAdsHierarchy(storeId)).rejects.toThrow('provider failed');
    expect(integrationService.failSyncRun).toHaveBeenCalledWith(syncRunId, expect.anything());
  });
});

describe('MetaService catalog and Insights sync', () => {
  it('syncs selected catalogs under a dedicated SyncRun', async () => {
    const { catalogService, integrationService, service } = build({ selectedCatalogIds: ['cat_1'] });
    const result = await service.syncCatalogs(storeId);

    expect(catalogService.syncSelectedCatalogs).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId }),
      ['cat_1'],
    );
    expect(result).toMatchObject({
      status: 'SUCCEEDED', resourceType: 'ProductCatalogs', recordsRead: 21, recordsWritten: 22,
    });
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 21,
      recordsWritten: 22,
      breakdown: expect.anything(),
    });
  });

  it('refreshes hierarchy immediately before attribution-aware daily Insights for every account', async () => {
    const { adsService, insightsService, integrationService, service } = build({
      selectedAdAccountIds: ['act_101', 'act_202'],
    });
    const result = await service.syncInsights(storeId);

    expect(adsService.syncSelectedAccount).toHaveBeenCalledTimes(2);
    expect(insightsService.syncAccount).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(adsService.syncSelectedAccount).mock.invocationCallOrder[0]!,
    ).toBeLessThan(vi.mocked(insightsService.syncAccount).mock.invocationCallOrder[0]!);
    expect(
      vi.mocked(adsService.syncSelectedAccount).mock.invocationCallOrder[1]!,
    ).toBeLessThan(vi.mocked(insightsService.syncAccount).mock.invocationCallOrder[1]!);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      resourceType: 'AdInsightsDaily',
      recordsRead: 24,
      recordsWritten: 26,
      staleRowsDeleted: 2,
      hierarchyRefreshedBeforeInsights: true,
      hierarchyRecordsRead: 10,
      hierarchyRecordsWritten: 12,
    });
    expect(integrationService.recordExternalPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'META',
        resourceType: 'AdInsightsSyncSummary',
        payload: expect.objectContaining({ hierarchyRefreshedBeforeInsights: true }),
      }),
    );
  });

  it('fails Insights sync before reading insights when the required hierarchy refresh fails', async () => {
    const { insightsService, integrationService, service } = build({ syncFails: true });

    await expect(service.syncInsights(storeId)).rejects.toThrow('provider failed');

    expect(insightsService.syncAccount).not.toHaveBeenCalled();
    expect(integrationService.failSyncRun).toHaveBeenCalledWith(syncRunId, expect.anything());
  });

  it('does not start data sync without its required selected asset', async () => {
    const { service } = build({ selectedAdAccountIds: [], selectedCatalogIds: [] });
    await expect(service.syncInsights(storeId)).rejects.toMatchObject({ code: 'META_ASSETS_NOT_CONFIGURED' });
    await expect(service.syncCatalogs(storeId)).rejects.toMatchObject({ code: 'META_CATALOGS_NOT_CONFIGURED' });
  });
});
