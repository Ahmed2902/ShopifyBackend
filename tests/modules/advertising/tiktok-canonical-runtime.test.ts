import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { CanonicalPaidMediaReadService } from '../../../src/modules/advertising/canonical-paid-media.read.service.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
const reads = new CanonicalPaidMediaReadService();

async function createStore(label: string) {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: label,
      myshopifyDomain: `tiktok-canonical-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  return store;
}

async function createHierarchy(input: {
  storeId: string;
  provider: 'TIKTOK' | 'META';
  accountExternalId: string;
  suffix: string;
}) {
  const account = await prisma.advertisingAccount.create({
    data: {
      storeId: input.storeId,
      provider: input.provider,
      providerEntityId: input.accountExternalId,
      name: `${input.provider} ${input.accountExternalId}`,
      currency: 'USD',
      timezone: 'UTC',
    },
  });
  const campaign = await prisma.advertisingCampaign.create({
    data: {
      accountId: account.id,
      providerEntityId: `campaign-${input.suffix}`,
      name: `Campaign ${input.suffix}`,
    },
  });
  const group = await prisma.advertisingGroup.create({
    data: {
      accountId: account.id,
      campaignId: campaign.id,
      providerEntityId: `group-${input.suffix}`,
      kind: input.provider === 'TIKTOK' ? 'AD_GROUP' : 'AD_SET',
      name: `Group ${input.suffix}`,
    },
  });
  const ad = await prisma.advertisingAd.create({
    data: {
      accountId: account.id,
      campaignId: campaign.id,
      groupId: group.id,
      providerEntityId: `ad-${input.suffix}`,
      name: `Ad ${input.suffix}`,
    },
  });
  return { account, campaign, group, ad };
}

async function addMetric(input: {
  accountId: string;
  campaignId: string;
  groupId: string;
  adId: string;
  suffix: string;
  currency: string;
  spend: number;
  conversions?: number | null;
  conversionValue?: number | null;
}) {
  await prisma.advertisingDailyMetric.create({
    data: {
      metricKey: `TIKTOK:test:${input.suffix}:${randomUUID()}`,
      accountId: input.accountId,
      campaignId: input.campaignId,
      groupId: input.groupId,
      adId: input.adId,
      level: 'AD',
      date: new Date('2026-09-22T00:00:00.000Z'),
      currency: input.currency,
      spend: input.spend,
      impressions: 100n,
      clicks: 10n,
      conversions: input.conversions ?? null,
      conversionValue: input.conversionValue ?? null,
    },
  });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('TikTok canonical paid-media runtime', () => {
  it('isolates selected advertiser/store/provider scope and preserves truth boundaries', async () => {
    const store = await createStore('TikTok canonical selected store');
    const otherStore = await createStore('TikTok canonical other store');

    const selected = await createHierarchy({
      storeId: store.id,
      provider: 'TIKTOK',
      accountExternalId: 'adv-selected',
      suffix: 'selected',
    });
    const unselected = await createHierarchy({
      storeId: store.id,
      provider: 'TIKTOK',
      accountExternalId: 'adv-unselected',
      suffix: 'unselected',
    });
    const crossStore = await createHierarchy({
      storeId: otherStore.id,
      provider: 'TIKTOK',
      accountExternalId: 'adv-selected',
      suffix: 'cross-store',
    });
    const crossProvider = await createHierarchy({
      storeId: store.id,
      provider: 'META',
      accountExternalId: 'adv-selected',
      suffix: 'meta',
    });
    await prisma.advertisingAd.create({
      data: {
        accountId: selected.account.id,
        campaignId: selected.campaign.id,
        groupId: selected.group.id,
        providerEntityId: 'ad-soft-deleted',
        name: 'Soft-deleted TikTok ad',
        deletedAt: new Date('2026-09-20T00:00:00.000Z'),
      },
    });

    await addMetric({ accountId: selected.account.id, campaignId: selected.campaign.id, groupId: selected.group.id, adId: selected.ad.id, suffix: 'usd', currency: 'USD', spend: 25 });
    await addMetric({ accountId: selected.account.id, campaignId: selected.campaign.id, groupId: selected.group.id, adId: selected.ad.id, suffix: 'eur', currency: 'EUR', spend: 7, conversions: 2, conversionValue: 18 });
    await addMetric({ accountId: unselected.account.id, campaignId: unselected.campaign.id, groupId: unselected.group.id, adId: unselected.ad.id, suffix: 'unselected', currency: 'USD', spend: 9999 });
    await addMetric({ accountId: crossStore.account.id, campaignId: crossStore.campaign.id, groupId: crossStore.group.id, adId: crossStore.ad.id, suffix: 'cross-store', currency: 'USD', spend: 8888 });
    await addMetric({ accountId: crossProvider.account.id, campaignId: crossProvider.campaign.id, groupId: crossProvider.group.id, adId: crossProvider.ad.id, suffix: 'cross-provider', currency: 'USD', spend: 7777 });

    const overview = await reads.overview({
      storeId: store.id,
      provider: 'TIKTOK',
      selectedAccountExternalIds: ['adv-selected'],
      accountId: selected.account.id,
      days: 30,
    });

    expect(overview.accounts.map((account) => account.id)).toEqual([selected.account.id]);
    expect(overview.counts).toMatchObject({ campaigns: 1, groups: 1, ads: 1 });
    expect(overview.metrics).toEqual([
      expect.objectContaining({ currency: 'EUR', spend: '7', conversions: '2', conversionValue: '18' }),
      expect.objectContaining({ currency: 'USD', spend: '25', conversions: null, conversionValue: null }),
    ]);

    const groups = await reads.list({
      storeId: store.id,
      provider: 'TIKTOK',
      selectedAccountExternalIds: ['adv-selected'],
      accountId: selected.account.id,
      level: 'GROUP',
      days: 30,
      page: 1,
      limit: 50,
    });
    expect(groups.items).toHaveLength(1);
    expect(groups.items[0]).toMatchObject({ id: selected.group.id, kind: 'AD_GROUP' });

    const ads = await reads.list({
      storeId: store.id,
      provider: 'TIKTOK',
      selectedAccountExternalIds: ['adv-selected'],
      accountId: selected.account.id,
      level: 'AD',
      days: 30,
      page: 1,
      limit: 50,
    });
    expect(ads.items.map((ad) => ad.id)).toEqual([selected.ad.id]);

    await expect(
      reads.overview({
        storeId: store.id,
        provider: 'TIKTOK',
        selectedAccountExternalIds: ['adv-selected'],
        accountId: unselected.account.id,
        days: 30,
      }),
    ).rejects.toMatchObject({ code: 'ADVERTISING_ACCOUNT_NOT_SELECTED' });

    await expect(
      reads.overview({
        storeId: store.id,
        provider: 'TIKTOK',
        selectedAccountExternalIds: ['adv-selected'],
        accountId: crossStore.account.id,
        days: 30,
      }),
    ).rejects.toMatchObject({ code: 'ADVERTISING_ACCOUNT_NOT_SELECTED' });

    await expect(
      reads.overview({
        storeId: store.id,
        provider: 'TIKTOK',
        selectedAccountExternalIds: ['adv-selected'],
        accountId: crossProvider.account.id,
        days: 30,
      }),
    ).rejects.toMatchObject({ code: 'ADVERTISING_ACCOUNT_NOT_SELECTED' });
  });
});
