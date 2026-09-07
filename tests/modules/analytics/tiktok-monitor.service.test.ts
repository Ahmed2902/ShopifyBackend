import { describe, expect, it, vi } from 'vitest';
import type { TikTokMonitorReadRepository } from '../../../src/modules/analytics/tiktok-monitor.read.repository.js';
import { TikTokMonitorService } from '../../../src/modules/analytics/tiktok-monitor.service.js';

function repository(overrides: Partial<TikTokMonitorReadRepository> = {}) {
  return {
    getConnection: vi.fn().mockResolvedValue({
      status: 'ACTIVE',
      selectedAdvertiserIds: ['adv_1'],
      lastSyncedAt: new Date('2026-09-07T10:00:00.000Z'),
    }),
    getCounts: vi.fn().mockResolvedValue({ campaigns: 12, groups: 30, ads: 80 }),
    getSummary: vi.fn().mockResolvedValue([
      {
        currency: 'USD',
        spend: 250,
        impressions: 10_000,
        clicks: 500,
        conversions: 25,
        conversionValue: 1_000,
        roas: 4,
        ctr: 5,
        cpc: 0.5,
        rowCount: 20,
        frequency: 1.5,
      },
    ]),
    getHierarchyPage: vi.fn().mockResolvedValue([
      {
        id: 'campaign-db-1',
        externalId: 'campaign-1',
        name: 'Campaign 1',
        status: 'ENABLE',
        secondaryStatus: null,
        parentName: null,
        objective: 'CONVERSIONS',
        thumbnailUrl: null,
        targetScope: null,
      },
    ]),
    getEntityMetrics: vi.fn().mockResolvedValue(
      new Map([
        [
          'campaign-db-1',
          {
            currency: 'USD',
            spend: 50,
            impressions: 2_000,
            clicks: 100,
            conversions: 5,
            conversionValue: 200,
            roas: 4,
            ctr: 5,
            cpc: 0.5,
          },
        ],
      ]),
    ),
    ...overrides,
  } as unknown as TikTokMonitorReadRepository;
}

describe('TikTokMonitorService', () => {
  it('returns one bounded hierarchy page plus compact whole-window summary', async () => {
    const read = repository();
    const service = new TikTokMonitorService(read);
    const result = await service.read(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { days: 14, level: 'campaigns', page: 1, limit: 50, fresh: false },
      new Date('2026-09-07T18:00:00.000Z'),
    );

    expect(result.window).toEqual({ days: 14, from: '2026-08-25', to: '2026-09-07' });
    expect(result.counts).toEqual({ campaigns: 12, groups: 30, ads: 80 });
    expect(result.hierarchy).toMatchObject({
      level: 'campaigns',
      page: 1,
      limit: 50,
      total: 12,
      totalPages: 1,
    });
    expect(result.hierarchy.items[0]).toMatchObject({
      externalId: 'campaign-1',
      metric: { spend: 50, roas: 4 },
    });
    expect(read.getHierarchyPage).toHaveBeenCalledTimes(1);
    expect(read.getEntityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ entityIds: ['campaign-db-1'], level: 'campaigns' }),
    );
  });

  it('short-circuits every analytical read when TikTok is not configured', async () => {
    const read = repository({
      getConnection: vi.fn().mockResolvedValue({
        status: 'DISCONNECTED',
        selectedAdvertiserIds: [],
        lastSyncedAt: null,
      }),
    });
    const result = await new TikTokMonitorService(read).read(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { days: 14, level: 'ads', page: 1, limit: 50, fresh: false },
    );

    expect(result.connection.configured).toBe(false);
    expect(result.hierarchy.items).toEqual([]);
    expect(read.getCounts).not.toHaveBeenCalled();
    expect(read.getSummary).not.toHaveBeenCalled();
    expect(read.getHierarchyPage).not.toHaveBeenCalled();
    expect(read.getEntityMetrics).not.toHaveBeenCalled();
  });
});
