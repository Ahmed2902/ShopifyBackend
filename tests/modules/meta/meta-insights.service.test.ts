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

type BuildOptions = {
  timezoneName?: string | null;
  creativeId?: string | null;
  metaUpdatedAt?: Date | null;
};

function build(
  hasInsights = false,
  rowsPerChunk: unknown[][] = [[insightRow()]],
  options: BuildOptions = {},
) {
  let pageIndex = 0;
  const timezoneName = options.timezoneName === undefined ? 'UTC' : options.timezoneName;
  const creativeId = options.creativeId === undefined ? 'local-creative' : options.creativeId;
  const metaUpdatedAt = options.metaUpdatedAt === undefined
    ? new Date('2026-08-20T00:00:00.000Z')
    : options.metaUpdatedAt;

  const repository = {
    findAccount: vi.fn().mockResolvedValue({
      id: 'local-account',
      metaAccountId: 'act_101',
      currency: 'USD',
      timezoneName,
    }),
    hasInsights: vi.fn().mockResolvedValue(hasInsights),
    getHierarchyMaps: vi.fn().mockResolvedValue({
      campaigns: new Map([['cmp_1', 'local-cmp']]),
      adSets: new Map([['set_1', 'local-set']]),
      ads: new Map([['ad_1', 'local-ad']]),
      adCreatives: new Map([['ad_1', { creativeId, metaUpdatedAt }]]),
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

  it('uses an exact provider-refreshed hierarchy snapshot without rereading mutable hierarchy rows', async () => {
    const { repository, service } = build(false, [[
      insightRow({ date_start: '2026-08-22', date_stop: '2026-08-22' }),
    ]]);
    const refreshedHierarchy = {
      campaigns: new Map([['cmp_1', 'fresh-cmp']]),
      adSets: new Map([['set_1', 'fresh-set']]),
      ads: new Map([['ad_1', 'fresh-ad']]),
      adCreatives: new Map([[
        'ad_1',
        { creativeId: 'fresh-creative', metaUpdatedAt: new Date('2026-08-20T00:00:00.000Z') },
      ]]),
    };

    await service.syncAccount(context, 'act_101', 1, refreshedHierarchy);

    expect(repository.getHierarchyMaps).not.toHaveBeenCalled();
    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'fresh-cmp',
        adSetId: 'fresh-set',
        adId: 'fresh-ad',
        creativeIdSnapshot: 'fresh-creative',
      }),
    );
  });

  it('enrolls a known current reporting-day row without attributing the in-progress daily aggregate', async () => {
    const { repository, service } = build(false, [[insightRow()]]);

    await service.syncAccount(context, 'act_101');

    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'local-cmp',
        adSetId: 'local-set',
        adId: 'local-ad',
        creativeIdSnapshot: null,
        trackCreativeSnapshot: true,
      }),
    );
  });

  it('does not enroll an unknown current ad for creative snapshot attribution', async () => {
    const { repository, service } = build(false, [[
      insightRow({ ad_id: 'old_ad', campaign_id: 'old_cmp', adset_id: 'old_set' }),
    ]]);

    await service.syncAccount(context, 'act_101');

    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: null,
        adSetId: null,
        adId: null,
        creativeIdSnapshot: null,
        trackCreativeSnapshot: false,
      }),
    );
  });

  it('offers a completed-day candidate only when the current creative predates the whole reporting day', async () => {
    const { repository, service } = build(false, [[
      insightRow({ date_start: '2026-08-22', date_stop: '2026-08-22' }),
    ]]);

    await service.syncAccount(context, 'act_101');

    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeIdSnapshot: 'local-creative',
        trackCreativeSnapshot: false,
      }),
    );
  });

  it('rejects a completed-day creative candidate when the ad changed during that reporting day', async () => {
    const { repository, service } = build(
      false,
      [[insightRow({ date_start: '2026-08-22', date_stop: '2026-08-22' })]],
      { metaUpdatedAt: new Date('2026-08-22T12:00:00.000Z') },
    );

    await service.syncAccount(context, 'act_101');

    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeIdSnapshot: null,
        trackCreativeSnapshot: false,
      }),
    );
  });

  it('uses the Meta ad-account timezone for the current reporting date near a UTC boundary', async () => {
    vi.setSystemTime(new Date('2026-08-23T00:30:00.000Z'));
    const { apiService, repository, service } = build(
      true,
      [[insightRow({ date_start: '2026-08-22', date_stop: '2026-08-22' })]],
      { timezoneName: 'America/Los_Angeles' },
    );

    await service.syncAccount(context, 'act_101', 1);

    expect(apiService.collectGraphPages).toHaveBeenCalledWith(
      context,
      '/act_101/insights',
      expect.objectContaining({
        time_range: JSON.stringify({ since: '2026-08-22', until: '2026-08-22' }),
      }),
      expect.any(Function),
    );
    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeIdSnapshot: null,
        trackCreativeSnapshot: true,
      }),
    );
  });

  it('does not track creative identity when the ad-account timezone is unavailable', async () => {
    const { repository, service } = build(false, [[insightRow()]], { timezoneName: null });

    await service.syncAccount(context, 'act_101');

    expect(repository.upsertDailyInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeIdSnapshot: null,
        trackCreativeSnapshot: false,
      }),
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
