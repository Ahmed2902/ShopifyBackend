import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';
import { MetaInsightsRepository } from '../../../src/modules/meta/insights/meta-insights.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStoreWithConnection(selectedAdAccountIds: string[]) {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Meta hardening test store',
      myshopifyDomain: `meta-hardening-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  createdStoreIds.push(store.id);

  const connection = await prisma.metaConnection.create({
    data: {
      storeId: store.id,
      accessTokenCiphertext: 'test-ciphertext',
      apiVersion: 'v26.0',
      selectedAdAccountIds,
    },
  });
  return { store, connection };
}

async function cleanupStore(storeId: string) {
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
    await prisma.adProductMapping.deleteMany({ where: { ad: { adAccountId: { in: accountIds } } } });
    await prisma.metaAd.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaCreative.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdSet.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaCampaign.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdAccount.deleteMany({ where: { id: { in: accountIds } } });
  }

  await prisma.metaConnection.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
}

afterEach(async () => {
  while (createdStoreIds.length > 0) {
    await cleanupStore(createdStoreIds.pop()!);
  }
});

describeDatabase('Meta repository hardening', () => {
  it('preserves locally resolved targeting when an ad hierarchy sync upserts the ad again', async () => {
    const { store, connection } = await createStoreWithConnection(['act_selected']);
    const account = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: connection.id,
        metaAccountId: 'act_selected',
        name: 'Selected account',
        currency: 'USD',
      },
    });
    const campaign = await prisma.metaCampaign.create({
      data: {
        adAccountId: account.id,
        metaCampaignId: 'campaign-1',
        name: 'Campaign',
      },
    });
    const adSet = await prisma.metaAdSet.create({
      data: {
        adAccountId: account.id,
        campaignId: campaign.id,
        metaAdSetId: 'adset-1',
        name: 'Ad set',
      },
    });
    await prisma.metaAd.create({
      data: {
        adAccountId: account.id,
        campaignId: campaign.id,
        adSetId: adSet.id,
        metaAdId: 'ad-1',
        name: 'Original ad',
        targetScope: 'PRODUCT',
        targetScopeConfidence: 0.99,
        targetScopeEvidence: { source: 'merchant-confirmed' },
      },
    });

    await new MetaAdsRepository().upsertAd(account.id, campaign.id, adSet.id, null, {
      id: 'ad-1',
      campaign_id: 'campaign-1',
      adset_id: 'adset-1',
      name: 'Synced ad name',
      effective_status: 'ACTIVE',
    });

    const ad = await prisma.metaAd.findFirstOrThrow({
      where: { adAccountId: account.id, metaAdId: 'ad-1' },
      select: {
        name: true,
        targetScope: true,
        targetScopeConfidence: true,
        targetScopeEvidence: true,
      },
    });
    expect(ad.name).toBe('Synced ad name');
    expect(ad.targetScope).toBe('PRODUCT');
    expect(Number(ad.targetScopeConfidence)).toBeCloseTo(0.99);
    expect(ad.targetScopeEvidence).toEqual({ source: 'merchant-confirmed' });
  });

  it('returns insights only from currently selected Meta ad accounts', async () => {
    const { store, connection } = await createStoreWithConnection(['act_selected']);
    const [selected, deselected] = await Promise.all([
      prisma.metaAdAccount.create({
        data: {
          storeId: store.id,
          metaConnectionId: connection.id,
          metaAccountId: 'act_selected',
          name: 'Selected account',
          currency: 'USD',
        },
      }),
      prisma.metaAdAccount.create({
        data: {
          storeId: store.id,
          metaConnectionId: connection.id,
          metaAccountId: 'act_deselected',
          name: 'Deselected account',
          currency: 'USD',
        },
      }),
    ]);

    const date = new Date('2026-08-23T00:00:00.000Z');
    await prisma.metaInsightDaily.createMany({
      data: [
        {
          insightKey: `selected-${randomUUID()}`,
          adAccountId: selected.id,
          level: 'AD',
          date,
          accountCurrency: 'USD',
          spend: 10,
        },
        {
          insightKey: `deselected-${randomUUID()}`,
          adAccountId: deselected.id,
          level: 'AD',
          date,
          accountCurrency: 'USD',
          spend: 999,
        },
      ],
    });

    const result = await new MetaInsightsRepository().listDaily(store.id, {
      from: date,
      to: date,
      page: 1,
      limit: 50,
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(Number(result.items[0]!.spend)).toBe(10);
  });
});
