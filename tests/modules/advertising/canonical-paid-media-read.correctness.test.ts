import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import {
  CanonicalPaidMediaReadService,
  canonicalPaidMediaReportingWindow,
} from '../../../src/modules/advertising/canonical-paid-media.read.service.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStore(timeZone = 'America/Los_Angeles') {
  const id = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${id}`,
      name: 'Canonical read correctness',
      myshopifyDomain: `canonical-${id}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: timeZone,
    },
  });
  createdStoreIds.push(store.id);
  return store;
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
});

describe('canonicalPaidMediaReportingWindow', () => {
  it('uses completed merchant-local dates instead of UTC midnight', () => {
    const now = new Date('2026-09-24T06:00:00.000Z');
    const losAngeles = canonicalPaidMediaReportingWindow(1, 'America/Los_Angeles', now);
    const cairo = canonicalPaidMediaReportingWindow(1, 'Africa/Cairo', now);

    expect(losAngeles.toDate).toBe('2026-09-22');
    expect(cairo.toDate).toBe('2026-09-23');
    expect(losAngeles.fromDate).toBe(losAngeles.toDate);
    expect(cairo.fromDate).toBe(cairo.toDate);
  });
});

describeDatabase('CanonicalPaidMediaReadService correctness', () => {
  it('reads Search from AD/GROUP facts, PMax Asset Groups from ASSET_GROUP facts, and never double-counts hierarchy levels', async () => {
    const store = await createStore('UTC');
    const service = new CanonicalPaidMediaReadService(
      () => new Date('2026-09-24T12:00:00.000Z'),
    );
    const account = await prisma.advertisingAccount.create({
      data: {
        storeId: store.id,
        provider: 'GOOGLE_ADS',
        providerEntityId: 'customer-1',
        name: 'Google Customer',
        currency: 'USD',
      },
    });
    const searchCampaign = await prisma.advertisingCampaign.create({
      data: {
        accountId: account.id,
        providerEntityId: 'search-campaign',
        name: 'Search',
        campaignType: 'SEARCH',
      },
    });
    const searchGroup = await prisma.advertisingGroup.create({
      data: {
        accountId: account.id,
        campaignId: searchCampaign.id,
        providerEntityId: 'search-group',
        kind: 'AD_GROUP',
        name: 'Search Group',
      },
    });
    const searchAd = await prisma.advertisingAd.create({
      data: {
        accountId: account.id,
        campaignId: searchCampaign.id,
        groupId: searchGroup.id,
        providerEntityId: 'search-ad',
        name: 'Search Ad',
      },
    });
    const pmaxCampaign = await prisma.advertisingCampaign.create({
      data: {
        accountId: account.id,
        providerEntityId: 'pmax-campaign',
        name: 'PMax',
        campaignType: 'PERFORMANCE_MAX',
      },
    });
    const assetGroup = await prisma.advertisingGroup.create({
      data: {
        accountId: account.id,
        campaignId: pmaxCampaign.id,
        providerEntityId: 'asset-group',
        kind: 'ASSET_GROUP',
        name: 'Asset Group',
      },
    });
    const date = new Date('2026-09-23T00:00:00.000Z');
    const metric = async (input: Parameters<typeof prisma.advertisingDailyMetric.create>[0]['data']) =>
      prisma.advertisingDailyMetric.create({ data: input });

    await metric({ metricKey: 'g-account', accountId: account.id, level: 'ACCOUNT', date, currency: 'USD', spend: 100, impressions: 1000n, clicks: 100n });
    await metric({ metricKey: 'g-search-campaign', accountId: account.id, campaignId: searchCampaign.id, level: 'CAMPAIGN', date, currency: 'USD', spend: 60, impressions: 600n, clicks: 60n });
    await metric({ metricKey: 'g-pmax-campaign', accountId: account.id, campaignId: pmaxCampaign.id, level: 'CAMPAIGN', date, currency: 'USD', spend: 40, impressions: 400n, clicks: 40n });
    await metric({ metricKey: 'g-search-group', accountId: account.id, campaignId: searchCampaign.id, groupId: searchGroup.id, level: 'GROUP', date, currency: 'USD', spend: 60, impressions: 600n, clicks: 60n });
    await metric({ metricKey: 'g-asset-group', accountId: account.id, campaignId: pmaxCampaign.id, groupId: assetGroup.id, level: 'ASSET_GROUP', date, currency: 'USD', spend: 40, impressions: 400n, clicks: 40n });
    await metric({ metricKey: 'g-search-ad', accountId: account.id, campaignId: searchCampaign.id, groupId: searchGroup.id, adId: searchAd.id, level: 'AD', date, currency: 'USD', spend: 60, impressions: 600n, clicks: 60n });

    const overview = await service.overview({
      storeId: store.id,
      provider: 'GOOGLE_ADS',
      selectedAccountExternalIds: ['customer-1'],
      days: 1,
    });
    expect(overview.metrics).toHaveLength(1);
    expect(overview.metrics[0]?.spend).toBe('100');

    const groups = await service.list({
      storeId: store.id,
      provider: 'GOOGLE_ADS',
      selectedAccountExternalIds: ['customer-1'],
      level: 'GROUP',
      days: 1,
      page: 1,
      limit: 10,
    });
    const search = groups.items.find((item) => item.id === searchGroup.id);
    const pmax = groups.items.find((item) => item.id === assetGroup.id);
    expect(search?.metrics[0]?.spend).toBe('60');
    expect(pmax?.metrics[0]?.spend).toBe('40');
    expect(await prisma.advertisingAd.count({ where: { campaignId: pmaxCampaign.id } })).toBe(0);

    const pmaxDetail = await service.detail({
      storeId: store.id,
      provider: 'GOOGLE_ADS',
      selectedAccountExternalIds: ['customer-1'],
      level: 'GROUP',
      entityId: assetGroup.id,
      days: 1,
    });
    expect(pmaxDetail.item?.metrics[0]?.spend).toBe('40');
  });

  it('rejects an external entity id that is ambiguous across selected accounts but resolves canonical UUIDs', async () => {
    const store = await createStore('UTC');
    const service = new CanonicalPaidMediaReadService(
      () => new Date('2026-09-24T12:00:00.000Z'),
    );
    const accountA = await prisma.advertisingAccount.create({
      data: { storeId: store.id, provider: 'TIKTOK', providerEntityId: 'advertiser-a', name: 'A' },
    });
    const accountB = await prisma.advertisingAccount.create({
      data: { storeId: store.id, provider: 'TIKTOK', providerEntityId: 'advertiser-b', name: 'B' },
    });
    const campaignA = await prisma.advertisingCampaign.create({
      data: { accountId: accountA.id, providerEntityId: 'duplicate-external-id', name: 'A campaign' },
    });
    await prisma.advertisingCampaign.create({
      data: { accountId: accountB.id, providerEntityId: 'duplicate-external-id', name: 'B campaign' },
    });

    await expect(
      service.detail({
        storeId: store.id,
        provider: 'TIKTOK',
        selectedAccountExternalIds: ['advertiser-a', 'advertiser-b'],
        level: 'CAMPAIGN',
        entityId: 'duplicate-external-id',
        days: 1,
      }),
    ).rejects.toMatchObject({ code: 'ADVERTISING_ENTITY_ID_AMBIGUOUS' });

    const byUuid = await service.detail({
      storeId: store.id,
      provider: 'TIKTOK',
      selectedAccountExternalIds: ['advertiser-a', 'advertiser-b'],
      level: 'CAMPAIGN',
      entityId: campaignA.id,
      days: 1,
    });
    expect(byUuid.item?.id).toBe(campaignA.id);
    expect(byUuid.item?.accountId).toBe(accountA.id);
  });
});
