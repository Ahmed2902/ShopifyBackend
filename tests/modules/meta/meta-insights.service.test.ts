import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaInsightsRepository } from '../../../src/modules/meta/insights/meta-insights.repository.js';
import { MetaInsightsService } from '../../../src/modules/meta/insights/meta-insights.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  accessToken: 'token',
  apiVersion: 'v26.0',
};

function insightRow(overrides: Record<string, unknown> = {}) {
  return {
    date_start: '2026-08-23',
    date_stop: '2026-08-23',
    account_id: '101',
    account_currency: 'USD',
    campaign_id: 'cmp_1',
    adset_id: 'set_1',
    ad_id: 'ad_1',
    spend: '12.34',
    impressions: '1000',
    clicks: '20',
    actions: [{ action_type: 'purchase', value: '2' }],
    action_values: [{ action_type: 'purchase', value: '79.98' }],
    ...overrides,
  };
}

function build(hasInsights = false, rowsPerChunk: unknown[][] = [[insightRow()]]) {
  let pageIndex = 0;
  const repository = {
    findAccount: vi.fn().mockResolvedValue({ id: 'local-account', metaAccountId: 'act_101', currency: 'USD' }),
    hasInsights: vi.fn().mockResolvedValue(hasInsights),
    getHierarchyMaps: vi.fn().mockResolvedValue({
      campaigns: new Map([['cmp_1', 'local-cmp']]),
      adSets: new Map([['set_1', 'local-set']]),
      ads: new Map([['ad_1', 'local-ad']]),
    }),
    upsertDailyInsight: vi.fn().mockImplementation(async ({ row }) => `key-${row.date_start}-${pageIndex}`),
    deleteMissingRange: vi.fn().mockResolvedValue({ count: 0 }),
  } as unknown as MetaInsightsRepository;
  const apiService = {
    collectGraphPages: vi.fn().mockImplementation(async () => rowsPerChunk[pageIndex++] ?? []),
  } as unknown as MetaApiService;
  return { repository, apiService, service: new MetaInsightsService(repository, apiService) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MetaInsightsService', () => {
  it('uses the configured 365-day first import split into bounded daily chunks', async () => {
    const { apiService, repository, service } = build(false, []);

    const result = await service.syncAccount(context, 'act_101');

    expect(result).toMatchObject({ lookbackDays: 365, initialBackfill: true });
    expect(apiService.collectGraphPages).toHaveBeenCalledTimes(14);
    expect(apiService.collectGraphPages).toHaveBeenNthCalledWith(
      1,
      context,
      '/act_101/insights',
      expect.objectContaining({
        level: 'ad',
        time_increment: '1',
        time_range: JSON.stringify({ since: '2025-08-24', until: '2025-09-20' }),
        use_unified_attribution_setting: 'true',
        action_report_time: 'impression',
      }),
      expect.any(Function),
    );
    expect(repository.deleteMissingRange).toHaveBeenCalledTimes(14);
  });

  it('refreshes a 35-day overlap after history already exists', async () => {
    const { apiService, service } = build(true, [[], []]);

    const result = await service.syncAccount(context, 'act_101');

    expect(result).toMatchObject({ lookbackDays: 35, initialBackfill: false });
    expect(apiService.collectGraphPages).toHaveBeenCalledTimes(2);
    expect(apiService.collectGraphPages).toHaveBeenNthCalledWith(
      1,
      context,
      '/act_101/insights',
      expect.objectContaining({
        time_range: JSON.stringify({ since: '2026-07-20', until: '2026-08-16' }),
      }),
      expect.any(Function),
    );
  });

  it('maps known hierarchy IDs while preserving rows whose historical ad is no longer current', async () => {
    const { repository, service } = build(false, [
      [
        insightRow(),
        insightRow({ ad_id: 'old_ad', campaign_id: 'old_cmp', adset_id: 'old_set' }),
      ],
    ]);

    await service.syncAccount(context, 'act_101');

    expect(repository.upsertDailyInsight).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ campaignId: 'local-cmp', adSetId: 'local-set', adId: 'local-ad' }),
    );
    expect(repository.upsertDailyInsight).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ campaignId: null, adSetId: null, adId: null }),
    );
  });

  it('rejects an Insights row that belongs to a different ad account', async () => {
    const { repository, service } = build(false, [[insightRow({ account_id: '999' })]]);

    await expect(service.syncAccount(context, 'act_101', 1)).rejects.toMatchObject({
      code: 'META_IDENTITY_MISMATCH',
    });
    expect(repository.upsertDailyInsight).not.toHaveBeenCalled();
    expect(repository.deleteMissingRange).not.toHaveBeenCalled();
  });

  it('accepts a manual bounded lookback for explicit re-imports', async () => {
    const { service } = build(true, [[]]);
    await expect(service.syncAccount(context, 'act_101', 7)).resolves.toMatchObject({ lookbackDays: 7 });
    await expect(service.syncAccount(context, 'act_101', 366)).rejects.toMatchObject({ code: 'INVALID_LOOKBACK' });
  });
});
