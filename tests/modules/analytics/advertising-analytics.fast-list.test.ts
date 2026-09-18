import { describe, expect, it, vi } from 'vitest';
import { AdvertisingAnalyticsService } from '../../../src/modules/analytics/advertising-analytics.service.js';
import type { AnalyticsWindows } from '../../../src/modules/analytics/analytics.shared.js';

const windows: AnalyticsWindows = {
  current: {
    fromDate: '2026-08-19',
    toDate: '2026-09-17',
    metaFrom: new Date('2026-08-19T00:00:00.000Z'),
    metaTo: new Date('2026-09-17T00:00:00.000Z'),
    instantFrom: new Date('2026-08-19T00:00:00.000Z'),
    instantTo: new Date('2026-09-17T23:59:59.999Z'),
  },
  comparison: {
    fromDate: '2026-07-20',
    toDate: '2026-08-18',
    metaFrom: new Date('2026-07-20T00:00:00.000Z'),
    metaTo: new Date('2026-08-18T00:00:00.000Z'),
    instantFrom: new Date('2026-07-20T00:00:00.000Z'),
    instantTo: new Date('2026-08-18T23:59:59.999Z'),
  },
  days: 30,
};

describe('AdvertisingAnalyticsService fast list reads', () => {
  it('aggregates a campaign page in SQL instead of materializing AD-day action rows', async () => {
    const getMetaRows = vi.fn();
    const getCampaignsPage = vi.fn().mockResolvedValue({
      total: 1,
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        metaCampaignId: 'meta-campaign-1',
        name: 'Prospecting',
      }],
    });
    const getAggregateRows = vi.fn().mockResolvedValue([
      {
        period: 'CURRENT',
        entityId: '11111111-1111-4111-8111-111111111111',
        accountCurrency: 'USD',
        spend: 100,
        impressions: 10_000,
        clicks: 500,
        purchases: 10,
        purchaseValue: 300,
        weightedFrequency: 15_000,
      },
      {
        period: 'COMPARISON',
        entityId: '11111111-1111-4111-8111-111111111111',
        accountCurrency: 'USD',
        spend: 80,
        impressions: 9_000,
        clicks: 450,
        purchases: 9,
        purchaseValue: 270,
        weightedFrequency: 12_600,
      },
    ]);

    const service = new AdvertisingAnalyticsService(
      { getCampaignsPage, getMetaRows } as never,
      {} as never,
      {} as never,
      {} as never,
      { getAggregateRows } as never,
    );
    const store = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      metaConnection: { selectedAdAccountIds: ['act_1'] },
    } as unknown as Parameters<AdvertisingAnalyticsService['campaigns']>[0];

    const result = await service.campaigns(store, windows, 1, 50);

    expect(getCampaignsPage).toHaveBeenCalledTimes(1);
    expect(getAggregateRows).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CAMPAIGN',
      entityIds: ['11111111-1111-4111-8111-111111111111'],
      selectedAccountIds: ['act_1'],
    }));
    expect(getMetaRows).not.toHaveBeenCalled();
    expect(result.items[0]?.current).toMatchObject({
      spend: 100,
      purchases: 10,
      providerRoas: 3,
      ctr: 0.05,
    });
    expect(result.items[0]?.currency).toBe('USD');
  });
});
