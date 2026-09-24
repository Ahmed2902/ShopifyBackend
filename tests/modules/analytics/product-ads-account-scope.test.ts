import { describe, expect, it, vi } from 'vitest';
import { ProductAdsWorkspace } from '../../../src/modules/analytics/product-ads.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const canonical101 = '11111111-1111-4111-8111-111111111111';
const canonical202 = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-22T08:00:00.000Z');

function unifiedEmptyResult(accountId?: string) {
  const period = {
    evidenceAvailable: true,
    compatiblePaidSpend: 0,
    exactMappedSpend: 0,
    sharedSpend: 0,
    ambiguousObservedSpend: 0,
    unmappedSpend: 0,
    mappingCoverage: 0,
    missingAccountIds: [],
    exactMappedSpendByProvider: { META: 0 },
  };
  return {
    schemaVersion: '2.0',
    filters: { provider: 'META', accountId: accountId ?? null, currency: null },
    window: {
      current: { from: '2026-08-24', to: '2026-09-22' },
      comparison: { from: '2026-07-25', to: '2026-08-23' },
      days: 30,
    },
    currency: 'USD',
    truthModel: {},
    mappingPolicy: {},
    methodology: {},
    summary: { current: period, comparison: period, change: {} },
    items: [],
    pagination: { page: 1, limit: 50, total: 0, pages: 0 },
  };
}

function buildHarness() {
  const analyticsRepository = {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    }),
  };
  const advertisingRepository = {
    connectionStates: vi.fn().mockResolvedValue([
      {
        provider: 'META',
        status: 'ACTIVE',
        selectedExternalIds: ['act_101', 'act_202'],
        lastSyncedAt: now,
        lastSyncStatus: 'SUCCEEDED',
      },
    ]),
    selectedAccounts: vi.fn().mockResolvedValue([
      {
        id: canonical101,
        provider: 'META',
        providerEntityId: 'act_101',
        name: 'Meta 101',
        status: 'ACTIVE',
        currency: 'USD',
        timezone: 'UTC',
        lastSyncedAt: now,
      },
      {
        id: canonical202,
        provider: 'META',
        providerEntityId: 'act_202',
        name: 'Meta 202',
        status: 'ACTIVE',
        currency: 'USD',
        timezone: 'UTC',
        lastSyncedAt: now,
      },
    ]),
  };
  const unifiedService = {
    list: vi.fn(async (_storeId: string, query: { accountId?: string }) =>
      unifiedEmptyResult(query.accountId),
    ),
    detail: vi.fn(),
  };
  const unifiedRepository = { activeMappings: vi.fn() };
  const compatibilityRepository = {
    netProductRevenueTotals: vi.fn().mockResolvedValue({ CURRENT: 0, COMPARISON: 0 }),
  };
  return {
    analyticsRepository,
    advertisingRepository,
    unifiedService,
    unifiedRepository,
    compatibilityRepository,
    workspace: new ProductAdsWorkspace(
      analyticsRepository as never,
      advertisingRepository as never,
      unifiedService as never,
      unifiedRepository as never,
      compatibilityRepository as never,
    ),
  };
}

describe('Product x Ads selected account scope', () => {
  it('translates the requested selected Meta external id to the canonical account id before unified reads', async () => {
    const { workspace, unifiedService } = buildHarness();

    await workspace.list(storeId, { days: 30, page: 1, limit: 50, accountId: 'act_202' }, now);

    expect(unifiedService.list).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        provider: 'META',
        accountId: canonical202,
        page: 1,
        limit: 50,
      }),
      now,
    );
  });

  it('rejects an account that is not selected before invoking the authoritative Product x Ads computation', async () => {
    const { workspace, unifiedService, compatibilityRepository } = buildHarness();

    await expect(
      workspace.list(
        storeId,
        { days: 30, page: 1, limit: 50, accountId: 'act_not_selected' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'META_AD_ACCOUNT_NOT_SELECTED', statusCode: 400 });

    expect(unifiedService.list).not.toHaveBeenCalled();
    expect(compatibilityRepository.netProductRevenueTotals).not.toHaveBeenCalled();
  });
});
