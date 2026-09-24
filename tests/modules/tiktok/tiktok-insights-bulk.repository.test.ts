import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../../src/generated/prisma/client.js';
import { prisma } from '../../../src/lib/prisma.js';
import {
  runWithRequestPerformanceContext,
  type RequestPerformanceContext,
} from '../../../src/observability/request-performance.js';
import { TikTokInsightsRepository } from '../../../src/modules/tiktok/insights/tiktok-insights.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
const repository = new TikTokInsightsRepository();

function performanceContext(): RequestPerformanceContext {
  return {
    requestId: randomUUID(),
    startedAtMs: performance.now(),
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
    spans: {},
    cacheOutcomes: { hit: 0, miss: 0, bypass: 0, error: 0, fresh: 0, coalesced: 0 },
    memoizedReads: new Map(),
  };
}

async function fixture(options: { canonical: boolean }) {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: `TikTok bulk ${suffix}`,
      myshopifyDomain: `tiktok-bulk-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  const connection = await prisma.tikTokConnection.create({
    data: {
      storeId: store.id,
      selectedAdvertiserIds: [`adv-${suffix}`],
      accessTokenCiphertext: 'test-token',
      apiVersion: 'v1.3',
    },
  });

  const accountId = randomUUID();
  const campaignId = randomUUID();
  const groupId = randomUUID();
  const adId = randomUUID();
  await prisma.tikTokAdvertiser.create({
    data: {
      id: accountId,
      storeId: store.id,
      tiktokConnectionId: connection.id,
      advertiserId: `adv-${suffix}`,
      name: 'Bulk advertiser',
      currency: 'USD',
    },
  });
  await prisma.tikTokCampaign.create({
    data: {
      id: campaignId,
      advertiserDbId: accountId,
      tiktokCampaignId: `campaign-${suffix}`,
      name: 'Bulk campaign',
    },
  });
  await prisma.tikTokAdGroup.create({
    data: {
      id: groupId,
      advertiserDbId: accountId,
      campaignId,
      tiktokAdGroupId: `group-${suffix}`,
      name: 'Bulk group',
    },
  });
  await prisma.tikTokAd.create({
    data: {
      id: adId,
      advertiserDbId: accountId,
      campaignId,
      adGroupId: groupId,
      tiktokAdId: `ad-${suffix}`,
      name: 'Bulk ad',
    },
  });

  if (options.canonical) {
    await prisma.advertisingAccount.create({
      data: {
        id: accountId,
        storeId: store.id,
        provider: 'TIKTOK',
        providerEntityId: `adv-${suffix}`,
        name: 'Bulk advertiser',
        currency: 'USD',
      },
    });
    await prisma.advertisingCampaign.create({
      data: {
        id: campaignId,
        accountId,
        providerEntityId: `campaign-${suffix}`,
        name: 'Bulk campaign',
      },
    });
    await prisma.advertisingGroup.create({
      data: {
        id: groupId,
        accountId,
        campaignId,
        providerEntityId: `group-${suffix}`,
        kind: 'AD_GROUP',
        name: 'Bulk group',
      },
    });
    await prisma.advertisingAd.create({
      data: {
        id: adId,
        accountId,
        campaignId,
        groupId,
        providerEntityId: `ad-${suffix}`,
        name: 'Bulk ad',
      },
    });
  }

  return { store, suffix, accountId, campaignId, groupId, adId };
}

function inputs(
  hierarchy: Awaited<ReturnType<typeof fixture>>,
  count: number,
): Prisma.TikTokInsightDailyUncheckedCreateInput[] {
  return Array.from({ length: count }, (_, index) => ({
    insightKey: `bulk:${hierarchy.suffix}:${index}`,
    advertiserDbId: hierarchy.accountId,
    campaignId: hierarchy.campaignId,
    adGroupId: hierarchy.groupId,
    adId: hierarchy.adId,
    level: 'AD',
    date: new Date(`2026-09-${String((index % 20) + 1).padStart(2, '0')}T00:00:00.000Z`),
    accountCurrency: 'USD',
    spend: index + 1,
    impressions: BigInt(100 + index),
    reach: BigInt(80 + index),
    clicks: BigInt(10 + index),
    conversions: index % 2 === 0 ? null : index,
    conversionValue: null,
    resultCount: index,
    metricsJson: { total_complete_payment_rate: '0.25', sourceIndex: index },
    dimensionsJson: { ad_id: `ad-${hierarchy.suffix}` },
    rawJson: { row: index },
    syncedAt: new Date('2026-09-24T00:00:00.000Z'),
  }));
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    const advertisers = await prisma.tikTokAdvertiser.findMany({
      where: { storeId },
      select: { id: true },
    });
    const advertiserIds = advertisers.map((row) => row.id);
    if (advertiserIds.length > 0) {
      await prisma.tikTokInsightDaily.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
      await prisma.tikTokAd.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
      await prisma.tikTokAdGroup.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
      await prisma.tikTokCampaign.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
      await prisma.tikTokAdvertiser.deleteMany({ where: { id: { in: advertiserIds } } });
    }
    await prisma.tikTokConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('TikTok set-based insight persistence', () => {
  it('writes native and canonical facts consistently, idempotently, and preserves null evidence', async () => {
    const hierarchy = await fixture({ canonical: true });
    const batch = inputs(hierarchy, 100);

    const written = await repository.upsertInsights(batch);
    expect(written).toHaveLength(100);
    const [native, canonical] = await Promise.all([
      prisma.tikTokInsightDaily.findMany({
        where: { advertiserDbId: hierarchy.accountId },
        orderBy: { insightKey: 'asc' },
      }),
      prisma.advertisingDailyMetric.findMany({
        where: { accountId: hierarchy.accountId },
        orderBy: { metricKey: 'asc' },
      }),
    ]);
    expect(native).toHaveLength(100);
    expect(canonical).toHaveLength(100);
    expect(canonical.every((row) => row.conversionValue === null)).toBe(true);
    expect(new Set(native.map((row) => row.id))).toEqual(new Set(canonical.map((row) => row.id)));

    const updated = batch.map((row, index) => ({
      ...row,
      spend: index === 0 ? 999 : row.spend,
      conversions: index === 0 ? 0 : row.conversions,
      conversionValue: null,
    }));
    await repository.upsertInsights(updated);

    expect(await prisma.tikTokInsightDaily.count({ where: { advertiserDbId: hierarchy.accountId } })).toBe(100);
    expect(await prisma.advertisingDailyMetric.count({ where: { accountId: hierarchy.accountId } })).toBe(100);
    const firstNative = await prisma.tikTokInsightDaily.findUnique({
      where: { insightKey: batch[0]!.insightKey },
    });
    const firstCanonical = await prisma.advertisingDailyMetric.findUnique({
      where: { metricKey: `TIKTOK:${batch[0]!.insightKey}` },
    });
    expect(firstNative?.spend.toString()).toBe('999');
    expect(firstCanonical?.spend.toString()).toBe('999');
    expect(firstNative?.conversions?.toString()).toBe('0');
    expect(firstCanonical?.conversions?.toString()).toBe('0');
    expect(firstCanonical?.conversionValue).toBeNull();
  });

  it('rolls back native evidence when canonical projection fails', async () => {
    const hierarchy = await fixture({ canonical: false });
    const batch = inputs(hierarchy, 3);

    await expect(repository.upsertInsights(batch)).rejects.toBeTruthy();
    expect(
      await prisma.tikTokInsightDaily.count({ where: { advertiserDbId: hierarchy.accountId } }),
    ).toBe(0);
    expect(
      await prisma.advertisingDailyMetric.count({ where: { accountId: hierarchy.accountId } }),
    ).toBe(0);
  });

  it('keeps database operations bounded as batch cardinality grows', async () => {
    const hierarchy = await fixture({ canonical: true });
    const oneContext = performanceContext();
    await runWithRequestPerformanceContext(oneContext, () =>
      repository.upsertInsights(inputs(hierarchy, 1)),
    );

    const largeContext = performanceContext();
    const large = inputs(hierarchy, 100).map((row) => ({
      ...row,
      insightKey: `${row.insightKey}:large`,
    }));
    await runWithRequestPerformanceContext(largeContext, () => repository.upsertInsights(large));

    expect(largeContext.queryCount).toBeLessThanOrEqual(oneContext.queryCount + 1);
    expect(largeContext.queryCount).toBeLessThan(10);
  });
});
