import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import { PerformanceAnalyticsWorkspace } from '../../../src/modules/analytics/performance-analytics.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function order(id: string, at: string, amount: number) {
  return {
    id,
    shopifyCreatedAt: new Date(at),
    processedAt: new Date(at),
    currencyCode: 'USD',
    currentSubtotalLineItemsQuantity: 1,
    currentTotalAmount: amount,
    currentTotalDiscountsAmount: 0,
    customerOrderIndex: 1,
    customerJourneyReady: true,
    refunds: [],
  };
}

function meta(date: string, spend: number, currency = 'USD') {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    accountCurrency: currency,
    spend,
    impressions: 1_000,
    clicks: 50,
    frequency: null,
    actions: [],
  };
}

function repositoryMock() {
  return {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'America/New_York',
      metaConnection: { status: 'ACTIVE', selectedAdAccountIds: ['act_101'] },
    }),
    getOrders: vi.fn().mockResolvedValue([
      // 01:00Z is still the previous merchant-local calendar day in New York.
      order('order-1', '2026-09-02T01:00:00.000Z', 120),
      order('order-2', '2026-09-03T16:00:00.000Z', 90),
    ]),
    getMetaRows: vi.fn().mockResolvedValue([
      meta('2026-09-02', 30),
      meta('2026-09-03', 30),
      meta('2026-09-03', 100, 'EUR'),
    ]),
  } as unknown as AnalyticsRepository;
}

describe('PerformanceAnalyticsWorkspace', () => {
  it('returns a zero-filled daily series plus backend-owned totals without mixing currencies', async () => {
    const repository = repositoryMock();
    const workspace = new PerformanceAnalyticsWorkspace(repository);

    const result = await workspace.daily(
      storeId,
      { from: '2026-09-01', to: '2026-09-03', days: 30 },
      new Date('2026-09-04T12:00:00.000Z'),
    );

    expect(result.granularity).toBe('DAY');
    expect(result.currency).toBe('USD');
    expect(result.advertisingCurrencyScope).toBe('STORE_CURRENCY_ONLY');
    expect(result.excludedMetaCurrencies).toEqual(['EUR']);
    expect(result.alignment).toBe('SHOPIFY_MERCHANT_LOCAL_DATE_WITH_META_PROVIDER_REPORT_DATE');
    expect(result.methodology.currency).toBe('PERFORMANCE_ADVERTISING_FILTERED_TO_STORE_CURRENCY');
    expect(result.points).toHaveLength(3);
    expect(result.points.map((point) => point.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);

    expect(result.points[0]).toMatchObject({
      commerce: { orders: 1, netOrderValue: 120 },
      advertising: { spend: 0 },
      blended: { mer: null },
    });
    expect(result.points[1]).toMatchObject({
      commerce: { orders: 0, netOrderValue: 0 },
      advertising: { spend: 30 },
      blended: { mer: 0 },
    });
    expect(result.points[2]).toMatchObject({
      commerce: { orders: 1, netOrderValue: 90 },
      advertising: { spend: 30, impressions: 1_000 },
      blended: { mer: 3 },
    });

    expect(result.summary).toMatchObject({
      commerce: { orders: 2, netOrderValue: 210 },
      advertising: { spend: 60, impressions: 2_000 },
      blended: { mer: 3.5 },
    });

    expect(repository.getMetaRows).toHaveBeenCalledWith(
      storeId,
      ['act_101'],
      expect.any(Date),
      expect.any(Date),
    );
  });
});
