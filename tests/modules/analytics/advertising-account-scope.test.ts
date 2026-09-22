import { describe, expect, it, vi } from 'vitest';
import type { AdvertisingAnalyticsReadRepository } from '../../../src/modules/analytics/advertising-analytics.read.repository.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import { AnalyticsWorkspace } from '../../../src/modules/analytics/analytics.workspace.js';
import type { CommerceAnalyticsReadRepository } from '../../../src/modules/analytics/commerce-analytics.read.repository.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-22T08:00:00.000Z');

function buildRepository() {
  return {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: null,
      metaConnection: {
        status: 'ACTIVE',
        selectedAdAccountIds: ['act_101', 'act_202'],
      },
    }),
    getLatestSuccessfulOrderHistorySync: vi.fn().mockResolvedValue(null),
  } as unknown as AnalyticsRepository;
}

function buildAdvertisingRead() {
  return {
    getOverviewAggregateRows: vi.fn().mockResolvedValue([]),
    getOverviewMeta: vi.fn().mockResolvedValue({
      campaigns: 0,
      ads: 0,
      lastInsightsSyncedAt: now,
    }),
  } as unknown as AdvertisingAnalyticsReadRepository;
}

function buildCommerceRead() {
  return {
    getOrderAggregates: vi.fn().mockResolvedValue([]),
    getProductEconomicsAggregates: vi.fn().mockResolvedValue([]),
  } as unknown as CommerceAnalyticsReadRepository;
}

describe('Meta advertising account scope', () => {
  it('narrows advertising reads to one configured account', async () => {
    const repository = buildRepository();
    const advertisingRead = buildAdvertisingRead();
    const workspace = new AnalyticsWorkspace(repository, advertisingRead);

    const result = await workspace.advertising(
      storeId,
      { days: 30, accountId: 'act_202' },
      now,
    );

    expect(result.selectedAdAccounts).toBe(1);
    expect(advertisingRead.getOverviewAggregateRows).toHaveBeenCalledWith(
      expect.objectContaining({ selectedAccountIds: ['act_202'] }),
    );
    expect(advertisingRead.getOverviewMeta).toHaveBeenCalledWith(storeId, ['act_202']);
  });

  it('applies the same account scope and keeps missing same-currency evidence unavailable', async () => {
    const repository = buildRepository();
    const advertisingRead = buildAdvertisingRead();
    const workspace = new AnalyticsWorkspace(repository, advertisingRead, buildCommerceRead());

    const result = await workspace.overview(
      storeId,
      { days: 30, accountId: 'act_202' },
      now,
    );

    expect(advertisingRead.getOverviewAggregateRows).toHaveBeenCalledWith(
      expect.objectContaining({ selectedAccountIds: ['act_202'] }),
    );
    expect(advertisingRead.getOverviewMeta).toHaveBeenCalledWith(storeId, ['act_202']);
    expect(result.availability.meta.selectedAdAccounts).toBe(1);
    expect(result.profitability.sameCurrencyAdSpendAvailable).toBe(false);
    expect(result.profitability.current.contributionAfterAds).toBeNull();
    expect(result.profitability.comparison.contributionAfterAds).toBeNull();
    expect(result.blended.sameCurrencySpendAvailable).toBe(false);
    expect(result.blended.current.mer).toBeNull();
    expect(result.blended.comparison.mer).toBeNull();
    expect(result.blended.change.metaSpend).toBeNull();
  });

  it('rejects an account that is not selected for the store', async () => {
    const workspace = new AnalyticsWorkspace(buildRepository(), buildAdvertisingRead());

    await expect(
      workspace.advertising(storeId, { days: 30, accountId: 'act_not_selected' }, now),
    ).rejects.toMatchObject({ code: 'META_AD_ACCOUNT_NOT_SELECTED', statusCode: 400 });
  });
});
