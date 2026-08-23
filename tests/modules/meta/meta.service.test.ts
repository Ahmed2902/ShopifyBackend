import { describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { MetaService } from '../../../src/modules/meta/meta.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';
import type { MetaAuthService } from '../../../src/modules/meta/shared/meta-auth.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function build() {
  const repository = {
    configureAssets: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(),
  } as unknown as MetaRepository;
  const authService = {
    getApiContext: vi.fn().mockResolvedValue({
      storeId,
      connectionId,
      accessToken: 'token',
      apiVersion: 'v26.0',
      scopes: ['ads_read', 'business_management'],
    }),
  } as unknown as MetaAuthService;
  const apiService = {
    listBusinesses: vi.fn().mockResolvedValue([{ id: 'biz_1', name: 'Store Business' }]),
    listAdAccounts: vi.fn().mockResolvedValue(accounts),
  } as unknown as MetaApiService;
  return {
    repository,
    authService,
    apiService,
    service: new MetaService(repository, authService, apiService),
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
