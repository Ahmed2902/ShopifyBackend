import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDatabase('canonical advertising schema', () => {
  it('scopes provider entity IDs by provider and cascades derived paid-media data with the store', async () => {
    const suffix = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `shop-${suffix}`,
        name: 'Canonical advertising fixture',
        myshopifyDomain: `${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });

    const sharedProviderEntityId = '12345';
    const [metaAccount, tiktokAccount] = await Promise.all([
      prisma.advertisingAccount.create({
        data: {
          storeId: store.id,
          provider: 'META',
          providerEntityId: sharedProviderEntityId,
          name: 'Meta account',
          currency: 'USD',
        },
      }),
      prisma.advertisingAccount.create({
        data: {
          storeId: store.id,
          provider: 'TIKTOK',
          providerEntityId: sharedProviderEntityId,
          name: 'TikTok account',
          currency: 'USD',
        },
      }),
    ]);

    expect(metaAccount.providerEntityId).toBe(tiktokAccount.providerEntityId);
    expect(metaAccount.id).not.toBe(tiktokAccount.id);

    const campaign = await prisma.advertisingCampaign.create({
      data: {
        accountId: metaAccount.id,
        providerEntityId: 'campaign-1',
        name: 'Campaign',
      },
    });
    const group = await prisma.advertisingGroup.create({
      data: {
        accountId: metaAccount.id,
        campaignId: campaign.id,
        providerEntityId: 'adset-1',
        kind: 'AD_SET',
        name: 'Ad set',
      },
    });
    const ad = await prisma.advertisingAd.create({
      data: {
        accountId: metaAccount.id,
        campaignId: campaign.id,
        groupId: group.id,
        providerEntityId: 'ad-1',
        name: 'Ad',
      },
    });
    await prisma.advertisingDailyMetric.create({
      data: {
        metricKey: `META:${suffix}`,
        accountId: metaAccount.id,
        campaignId: campaign.id,
        groupId: group.id,
        adId: ad.id,
        level: 'AD',
        date: new Date('2026-09-21T00:00:00.000Z'),
        currency: 'USD',
        spend: '10',
        impressions: 1000n,
        clicks: 50n,
      },
    });

    await prisma.store.delete({ where: { id: store.id } });

    const [accounts, campaigns, groups, ads, metrics] = await Promise.all([
      prisma.advertisingAccount.count({ where: { storeId: store.id } }),
      prisma.advertisingCampaign.count({ where: { accountId: metaAccount.id } }),
      prisma.advertisingGroup.count({ where: { accountId: metaAccount.id } }),
      prisma.advertisingAd.count({ where: { accountId: metaAccount.id } }),
      prisma.advertisingDailyMetric.count({ where: { accountId: metaAccount.id } }),
    ]);

    expect({ accounts, campaigns, groups, ads, metrics }).toEqual({
      accounts: 0,
      campaigns: 0,
      groups: 0,
      ads: 0,
      metrics: 0,
    });
  });
});
