import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';
import type { MetaAdsService } from '../../../src/modules/meta/ads/meta-ads.service.js';
import type { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { MetaService } from '../../../src/modules/meta/meta.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';
import type { MetaAuthService } from '../../../src/modules/meta/shared/meta-auth.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const accounts = [
  {
    id: 'act_101',
    accountId: '101',
    name: 'Primary',
    accountStatus: 1,
    currency: 'USD',
    timezoneName: 'America/New_York',
    timezoneId: 1,
    timezoneOffsetHoursUtc: -4,
    amountSpentMinor: 1000n,
    balanceMinor: 0n,
    spendCapMinor: null,
    business: { id: 'biz_1', name: 'Store Business' },
    raw: { id: 'act_101' },
  },
  {
    id: 'act_202',
    accountId: '202',
    name: 'Secondary',
    accountStatus: 1,
    currency: 'USD',
    timezoneName: 'America/New_York',
    timezoneId: 1,
    timezoneOffsetHoursUtc: -4,
    amountSpentMinor: 500n,
    balanceMinor: 0n,
    spendCapMinor: null,
    business: { id: 'biz_1', name: 'Store Business' },
    raw: { id: 'act_202' },
  },
];

function build(options?: { selectedAdAccountIds?: string[]; syncFails?: boolean }) {
  const selectedAdAccountIds = options?.selectedAdAccountIds ?? ['act_101'];
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
      scopes: ['ads_read', 'business_management'],
      metaBusinessId: 'biz_1',
      selectedAdAccountIds,
      selectedCatalogIds: [],
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
            adAccounts: 1,
            campaigns: 1,
            adSets: 1,
            creatives: 1,
            ads: 1,
            softDeletedCampaigns: 1,
            softDeletedAdSets: 0,
            softDeletedCreatives: 0,
            softDeletedAds: 0,
          },
        }),
  } as unknown as MetaAdsService;
  const adsRepository = {
    listAdAccounts: vi.fn().mockResolvedValue([]),
    listCampaigns: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listAdSets: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listAds: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getAd: vi.fn().mockResolvedValue(null),
  } as unknown as MetaAdsRepository;
  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;

  return {
    repository,
    authService,
    apiService,
    adsService,
    adsRepository,
    integrationService,
    service: new MetaService(
      repository,
      authService,
      apiService,
      adsService,
      adsRepository,
      integrationService,
    ),
  };
}

describe('MetaService asset configuration', () => {
  it('discovers businesses and ad accounts without persisting unselected assets', async () => {
    const { repository, service } = build();
    const result = await service.discoverAssets(storeId);

    expect(result.businesses).toEqual([{ id: 'biz_1', name: 'Store Business' }]);
    expect(result.adAccounts).toHaveLength(2);
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

  it('rejects a business that was not returned by Meta', async () => {
    const { service } = build();
    await expect(
      service.configureAssets(storeId, { metaBusinessId: 'biz_missing', adAccountIds: ['101'] }),
    ).rejects.toMatchObject({ code: 'META_BUSINESS_NOT_ACCESSIBLE' });
  });
});

describe('MetaService ads hierarchy sync', () => {
  it('syncs each selected account, completes one SyncRun and records a summary', async () => {
    const { repository, adsService, integrationService, service } = build({
      selectedAdAccountIds: ['act_101', 'act_202'],
    });

    const result = await service.syncAdsHierarchy(storeId);

    expect(adsService.syncSelectedAccount).toHaveBeenCalledTimes(2);
    expect(adsService.syncSelectedAccount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ connectionId }),
      'act_101',
    );
    expect(result).toMatchObject({
      syncRunId,
      status: 'SUCCEEDED',
      resourceType: 'AdsHierarchy',
      recordsRead: 10,
      recordsWritten: 12,
      breakdown: { adAccounts: 2, campaigns: 2, ads: 2, softDeletedCampaigns: 2 },
    });
    expect(repository.markConnectionSynced).toHaveBeenCalledWith(connectionId);
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 10,
      recordsWritten: 12,
    });
    expect(integrationService.recordExternalPayload).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'META', resourceType: 'AdsHierarchySyncSummary' }),
    );
  });

  it('requires an explicitly selected ad account', async () => {
    const { integrationService, service } = build({ selectedAdAccountIds: [] });

    await expect(service.syncAdsHierarchy(storeId)).rejects.toMatchObject({
      code: 'META_ASSETS_NOT_CONFIGURED',
    });
    expect(integrationService.startSyncRun).not.toHaveBeenCalled();
  });

  it('fails the SyncRun when a provider account sync fails', async () => {
    const { integrationService, service } = build({ syncFails: true });

    await expect(service.syncAdsHierarchy(storeId)).rejects.toThrow('provider failed');
    expect(integrationService.failSyncRun).toHaveBeenCalledWith(syncRunId, expect.anything());
    expect(integrationService.completeSyncRun).not.toHaveBeenCalled();
  });
});
