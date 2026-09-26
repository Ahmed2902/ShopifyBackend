import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { UnifiedProductAdsRepository } from '../../../src/modules/analytics/unified-product-ads.repository.js';

const metaAccountId = '33333333-3333-4333-8333-333333333333';
const tiktokAccountId = '44444444-4444-4444-8444-444444444444';
const metaAdId = '55555555-5555-4555-8555-555555555555';
const tiktokAdId = '66666666-6666-4666-8666-666666666666';

const accounts = [
  {
    id: metaAccountId,
    provider: 'META' as const,
    providerEntityId: 'act_meta',
    name: 'Meta account',
    status: 'ACTIVE',
    currency: 'USD',
    timezone: 'UTC',
    lastSyncedAt: null,
  },
  {
    id: tiktokAccountId,
    provider: 'TIKTOK' as const,
    providerEntityId: 'adv_tiktok',
    name: 'TikTok account',
    status: 'ACTIVE',
    currency: 'USD',
    timezone: 'UTC',
    lastSyncedAt: null,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UnifiedProductAdsRepository provider evidence completeness', () => {
  it('keeps completeness at each contributing ad row instead of nulling every same-currency provider', async () => {
    vi.spyOn(prisma.advertisingDailyMetric, 'groupBy').mockResolvedValue([
      {
        adId: metaAdId,
        accountId: metaAccountId,
        currency: 'USD',
        _count: { _all: 2, conversions: 1, conversionValue: 2 },
        _sum: {
          spend: 10,
          impressions: 100,
          clicks: 10,
          conversions: 2,
          conversionValue: 50,
        },
      },
      {
        adId: tiktokAdId,
        accountId: tiktokAccountId,
        currency: 'USD',
        _count: { _all: 2, conversions: 2, conversionValue: 1 },
        _sum: {
          spend: 7,
          impressions: 70,
          clicks: 7,
          conversions: 0,
          conversionValue: 30,
        },
      },
    ] as never);

    const repository = new UnifiedProductAdsRepository();
    const rows = await repository.adMetricRows({
      accounts,
      adIds: [metaAdId, tiktokAdId],
      currentFrom: new Date('2026-09-01T00:00:00.000Z'),
      currentTo: new Date('2026-09-26T00:00:00.000Z'),
      comparisonFrom: new Date('2026-08-06T00:00:00.000Z'),
      comparisonTo: new Date('2026-08-31T00:00:00.000Z'),
    });

    const current = rows.filter((row) => row.period === 'CURRENT');
    expect(current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: metaAdId,
          accountId: metaAccountId,
          conversions: null,
          conversionValue: 50,
        }),
        expect.objectContaining({
          adId: tiktokAdId,
          accountId: tiktokAccountId,
          conversions: 0,
          conversionValue: null,
        }),
      ]),
    );
  });
});