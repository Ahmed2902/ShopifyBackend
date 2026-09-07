import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { TikTokMonitorReadRepository } from '../../../src/modules/analytics/tiktok-monitor.read.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function fixture() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'TikTok monitor performance',
      myshopifyDomain: `tiktok-monitor-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  const connection = await prisma.tikTokConnection.create({
    data: {
      storeId: store.id,
      status: 'ACTIVE',
      selectedAdvertiserIds: ['adv_selected'],
      accessTokenCiphertext: 'ciphertext',
      scopes: ['advertiser.read'],
      apiVersion: 'v1.3',
      lastSyncedAt: new Date('2026-09-07T10:00:00.000Z'),
    },
  });

  async function advertiser(advertiserId: string, name: string) {
    return prisma.tikTokAdvertiser.create({
      data: {
        storeId: store.id,
        tiktokConnectionId: connection.id,
        advertiserId,
        name,
        currency: 'USD',
      },
    });
  }

  const selected = await advertiser('adv_selected', 'Selected advertiser');
  const deselected = await advertiser('adv_other', 'Other advertiser');

  async function hierarchy(advertiserDbId: string, suffix: string) {
    const campaign = await prisma.tikTokCampaign.create({
      data: {
        advertiserDbId,
        tiktokCampaignId: `campaign_${suffix}`,
        name: `Campaign ${suffix}`,
        operationStatus: 'ENABLE',
      },
    });
    const group = await prisma.tikTokAdGroup.create({
      data: {
        advertiserDbId,
        campaignId: campaign.id,
        tiktokAdGroupId: `group_${suffix}`,
        name: `Group ${suffix}`,
        operationStatus: 'ENABLE',
      },
    });
    const ad = await prisma.tikTokAd.create({
      data: {
        advertiserDbId,
        campaignId: campaign.id,
        adGroupId: group.id,
        tiktokAdId: `ad_${suffix}`,
        name: `Ad ${suffix}`,
        operationStatus: 'ENABLE',
      },
    });
    return { campaign, group, ad };
  }

  const selectedHierarchy = await hierarchy(selected.id, 'selected');
  const otherHierarchy = await hierarchy(deselected.id, 'other');

  await prisma.tikTokInsightDaily.createMany({
    data: [
      {
        insightKey: `${unique}:selected:1`,
        advertiserDbId: selected.id,
        campaignId: selectedHierarchy.campaign.id,
        adGroupId: selectedHierarchy.group.id,
        adId: selectedHierarchy.ad.id,
        level: 'AD',
        date: new Date('2026-09-06T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: '100',
        impressions: 1_000n,
        clicks: 100n,
        conversions: '2',
        conversionValue: '300',
        frequency: '1.5',
      },
      {
        insightKey: `${unique}:selected:2`,
        advertiserDbId: selected.id,
        campaignId: selectedHierarchy.campaign.id,
        adGroupId: selectedHierarchy.group.id,
        adId: selectedHierarchy.ad.id,
        level: 'AD',
        date: new Date('2026-09-07T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: '50',
        impressions: 500n,
        clicks: 25n,
        conversions: '1',
        conversionValue: '100',
        frequency: '2',
      },
      // A different insight level for the same advertiser must not be double counted.
      {
        insightKey: `${unique}:campaign-level`,
        advertiserDbId: selected.id,
        campaignId: selectedHierarchy.campaign.id,
        level: 'CAMPAIGN',
        date: new Date('2026-09-07T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: '150',
        impressions: 1_500n,
        clicks: 125n,
        conversions: '3',
        conversionValue: '400',
      },
      // Synced but not selected by the merchant.
      {
        insightKey: `${unique}:other`,
        advertiserDbId: deselected.id,
        campaignId: otherHierarchy.campaign.id,
        adGroupId: otherHierarchy.group.id,
        adId: otherHierarchy.ad.id,
        level: 'AD',
        date: new Date('2026-09-07T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: '999',
        impressions: 9_999n,
        clicks: 999n,
        conversions: '99',
        conversionValue: '9999',
      },
    ],
  });

  return { store, selectedHierarchy };
}

async function cleanup(storeId: string) {
  const advertisers = await prisma.tikTokAdvertiser.findMany({ where: { storeId }, select: { id: true } });
  const advertiserIds = advertisers.map((item) => item.id);
  if (advertiserIds.length > 0) {
    await prisma.tikTokInsightDaily.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
    await prisma.tikTokAdProductMapping.deleteMany({ where: { ad: { advertiserDbId: { in: advertiserIds } } } });
    await prisma.tikTokAd.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
    await prisma.tikTokAdGroup.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
    await prisma.tikTokCampaign.deleteMany({ where: { advertiserDbId: { in: advertiserIds } } });
    await prisma.tikTokAdvertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  }
  await prisma.tikTokConnection.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('TikTokMonitorReadRepository', () => {
  it('aggregates selected AD-level evidence and only returns the visible hierarchy page', async () => {
    const { store, selectedHierarchy } = await fixture();
    const repository = new TikTokMonitorReadRepository();
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-07T00:00:00.000Z');

    const connection = await repository.getConnection(store.id);
    const selected = connection!.selectedAdvertiserIds;
    const [counts, summary, page] = await Promise.all([
      repository.getCounts(store.id, selected),
      repository.getSummary(store.id, selected, from, to),
      repository.getHierarchyPage({
        storeId: store.id,
        selectedAdvertiserIds: selected,
        level: 'campaigns',
        page: 1,
        limit: 50,
      }),
    ]);
    const metrics = await repository.getEntityMetrics({
      storeId: store.id,
      selectedAdvertiserIds: selected,
      level: 'campaigns',
      entityIds: page.map((item) => item.id),
      from,
      to,
    });

    expect(counts).toEqual({ campaigns: 1, groups: 1, ads: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ id: selectedHierarchy.campaign.id, externalId: 'campaign_selected' });
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      currency: 'USD',
      rowCount: 2,
      spend: 150,
      impressions: 1_500,
      clicks: 125,
      conversions: 3,
      conversionValue: 400,
    });
    expect(summary[0]!.roas).toBeCloseTo(400 / 150);
    expect(summary[0]!.frequency).toBeCloseTo((1.5 * 1_000 + 2 * 500) / 1_500);
    expect(metrics.get(selectedHierarchy.campaign.id)).toMatchObject({
      spend: 150,
      impressions: 1_500,
      clicks: 125,
      conversions: 3,
      conversionValue: 400,
    });
  });
});
