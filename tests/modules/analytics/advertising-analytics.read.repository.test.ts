import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { AdvertisingAnalyticsReadRepository } from '../../../src/modules/analytics/advertising-analytics.read.repository.js';
import { aggregateMeta } from '../../../src/modules/analytics/analytics.metrics.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createInsight(input: {
  adAccountId: string;
  date: string;
  currency?: string;
  level?: 'AD' | 'CAMPAIGN';
  spend: number;
  impressions: number;
  clicks: number;
  frequency?: number | null;
  attributionSetting?: string | null;
}) {
  return prisma.metaInsightDaily.create({
    data: {
      insightKey: `overview-parity-${randomUUID()}`,
      adAccountId: input.adAccountId,
      level: input.level ?? 'AD',
      date: new Date(`${input.date}T00:00:00.000Z`),
      accountCurrency: input.currency ?? 'USD',
      spend: input.spend,
      impressions: BigInt(input.impressions),
      clicks: BigInt(input.clicks),
      frequency: input.frequency ?? null,
      attributionSetting: input.attributionSetting ?? null,
    },
  });
}

async function addAction(
  insightId: string,
  kind: 'ACTION' | 'ACTION_VALUE' | 'PURCHASE_ROAS' | 'WEBSITE_PURCHASE_ROAS',
  actionType: string,
  value: number,
) {
  await prisma.metaInsightAction.create({
    data: {
      actionKey: `overview-action-${randomUUID()}`,
      insightId,
      kind,
      actionType,
      value,
    },
  });
}

async function fixture() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Meta overview aggregate parity',
      myshopifyDomain: `meta-overview-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);

  const connection = await prisma.metaConnection.create({
    data: {
      storeId: store.id,
      accessTokenCiphertext: 'test-ciphertext',
      apiVersion: 'v26.0',
      selectedAdAccountIds: ['act_selected'],
    },
  });
  const selected = await prisma.metaAdAccount.create({
    data: {
      storeId: store.id,
      metaConnectionId: connection.id,
      metaAccountId: 'act_selected',
      name: 'Selected account',
      currency: 'USD',
    },
  });
  const deselected = await prisma.metaAdAccount.create({
    data: {
      storeId: store.id,
      metaConnectionId: connection.id,
      metaAccountId: 'act_deselected',
      name: 'Deselected account',
      currency: 'USD',
    },
  });

  const currentDirect = await createInsight({
    adAccountId: selected.id,
    date: '2026-09-01',
    spend: 100,
    impressions: 1_000,
    clicks: 100,
    frequency: 1.5,
    attributionSetting: '7d_click_1d_view',
  });
  await addAction(currentDirect.id, 'ACTION', 'offsite_conversion.fb_pixel_purchase', 2);
  await addAction(currentDirect.id, 'ACTION', 'omni_purchase', 5);
  await addAction(currentDirect.id, 'ACTION', 'purchase', 9);
  await addAction(currentDirect.id, 'ACTION_VALUE', 'offsite_conversion.fb_pixel_purchase', 240);
  await addAction(currentDirect.id, 'ACTION_VALUE', 'purchase', 900);
  await addAction(currentDirect.id, 'WEBSITE_PURCHASE_ROAS', 'offsite_conversion.fb_pixel_purchase', 8);

  const currentFallback = await createInsight({
    adAccountId: selected.id,
    date: '2026-09-02',
    spend: 50,
    impressions: 500,
    clicks: 25,
    frequency: 2,
    attributionSetting: '1d_view',
  });
  await addAction(currentFallback.id, 'ACTION', 'omni_purchase', 1);
  await addAction(currentFallback.id, 'WEBSITE_PURCHASE_ROAS', 'omni_purchase', 3);
  await addAction(currentFallback.id, 'PURCHASE_ROAS', 'omni_purchase', 4);

  await createInsight({
    adAccountId: selected.id,
    date: '2026-09-02',
    currency: 'EUR',
    spend: 20,
    impressions: 200,
    clicks: 10,
    frequency: 1.2,
    attributionSetting: '7d_click_1d_view',
  });

  const comparison = await createInsight({
    adAccountId: selected.id,
    date: '2026-08-31',
    spend: 80,
    impressions: 800,
    clicks: 40,
    frequency: 1.25,
    attributionSetting: '7d_click_1d_view',
  });
  await addAction(comparison.id, 'ACTION', 'purchase', 3);
  await addAction(comparison.id, 'ACTION_VALUE', 'purchase', 0);
  await addAction(comparison.id, 'WEBSITE_PURCHASE_ROAS', 'purchase', 0);
  await addAction(comparison.id, 'PURCHASE_ROAS', 'purchase', 2);

  // These rows must never leak into the compact overview.
  await createInsight({
    adAccountId: deselected.id,
    date: '2026-09-01',
    spend: 9_999,
    impressions: 99_999,
    clicks: 9_999,
  });
  await createInsight({
    adAccountId: selected.id,
    date: '2026-09-01',
    level: 'CAMPAIGN',
    spend: 8_888,
    impressions: 88_888,
    clicks: 8_888,
  });
  await createInsight({
    adAccountId: selected.id,
    date: '2026-08-20',
    spend: 7_777,
    impressions: 77_777,
    clicks: 7_777,
  });

  return { store, selectedAccountIds: ['act_selected'] };
}

async function cleanup(storeId: string) {
  const accounts = await prisma.metaAdAccount.findMany({
    where: { storeId },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length > 0) {
    await prisma.metaInsightAction.deleteMany({
      where: { insight: { adAccountId: { in: accountIds } } },
    });
    await prisma.metaInsightDaily.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdAccount.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.metaConnection.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

describeDatabase('AdvertisingAnalyticsReadRepository', () => {
  it('matches established aggregateMeta semantics while returning only period/currency totals', async () => {
    const { store, selectedAccountIds } = await fixture();
    const repository = new AdvertisingAnalyticsReadRepository();
    const currentFrom = new Date('2026-09-01T00:00:00.000Z');
    const currentTo = new Date('2026-09-02T00:00:00.000Z');
    const comparisonFrom = new Date('2026-08-30T00:00:00.000Z');
    const comparisonTo = new Date('2026-08-31T00:00:00.000Z');

    const [legacyRows, compactRows] = await Promise.all([
      repository.getOverviewMetricRows(
        store.id,
        selectedAccountIds,
        comparisonFrom,
        currentTo,
      ),
      repository.getOverviewAggregateRows({
        storeId: store.id,
        selectedAccountIds,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
    ]);

    expect(compactRows).toHaveLength(3);
    for (const compact of compactRows) {
      const periodRows = legacyRows.filter((row) => {
        const key = dateKey(row.date);
        const inCurrent = key >= '2026-09-01' && key <= '2026-09-02';
        const period = inCurrent ? 'CURRENT' : 'COMPARISON';
        return period === compact.period && row.accountCurrency === compact.accountCurrency;
      });
      const expected = aggregateMeta(periodRows);

      expect(compact).toMatchObject({
        spend: expected.spend,
        impressions: expected.impressions,
        clicks: expected.clicks,
        purchases: expected.purchases,
        purchaseValue: expected.purchaseValue,
      });
      expect(compact.weightedFrequency).toBeCloseTo(
        (expected.averageDailyFrequency ?? 0) * expected.impressions,
      );
      expect(new Set(compact.attributionSettings)).toEqual(
        new Set(periodRows.map((row) => row.attributionSetting).filter(Boolean)),
      );
    }

    const currentUsd = compactRows.find(
      (row) => row.period === 'CURRENT' && row.accountCurrency === 'USD',
    );
    const comparisonUsd = compactRows.find(
      (row) => row.period === 'COMPARISON' && row.accountCurrency === 'USD',
    );
    expect(currentUsd).toMatchObject({ spend: 150, purchases: 3, purchaseValue: 390 });
    expect(comparisonUsd).toMatchObject({ spend: 80, purchases: 3, purchaseValue: 160 });
  });
});
