import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { AdvertisingIntelligenceReadRepository } from '../../../src/modules/advertising/advertising-intelligence-read.repository.js';
import {
  buildCampaignEvidence,
  buildCreativeEvidence,
} from '../../../src/modules/intelligence/intelligence.metrics.js';
import { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
const PURCHASE_ACTION_TYPE = 'offsite_conversion.fb_pixel_purchase';

async function addAction(
  insightId: string,
  kind: 'ACTION' | 'ACTION_VALUE' | 'PURCHASE_ROAS' | 'WEBSITE_PURCHASE_ROAS',
  actionType: string,
  value: number,
) {
  await prisma.metaInsightAction.create({
    data: {
      actionKey: `canonical-intelligence-action-${randomUUID()}`,
      insightId,
      kind,
      actionType,
      value,
      metadata: { action_type: actionType, value: String(value) },
    },
  });
}

async function fixture() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Canonical intelligence parity',
      myshopifyDomain: `canonical-intelligence-${suffix}.myshopify.com`,
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
  const account = await prisma.metaAdAccount.create({
    data: {
      storeId: store.id,
      metaConnectionId: connection.id,
      metaAccountId: 'act_selected',
      name: 'Selected account',
      currency: 'USD',
    },
  });
  await prisma.advertisingAccount.create({
    data: {
      id: account.id,
      storeId: store.id,
      provider: 'META',
      providerEntityId: account.metaAccountId,
      name: account.name,
      currency: account.currency,
    },
  });

  const campaign = await prisma.metaCampaign.create({
    data: {
      adAccountId: account.id,
      metaCampaignId: `campaign-${suffix}`,
      name: 'Parity campaign',
    },
  });
  const adSet = await prisma.metaAdSet.create({
    data: {
      adAccountId: account.id,
      campaignId: campaign.id,
      metaAdSetId: `adset-${suffix}`,
      name: 'Parity ad set',
    },
  });
  const creative = await prisma.metaCreative.create({
    data: {
      adAccountId: account.id,
      metaCreativeId: `creative-${suffix}`,
      name: 'Parity creative',
      title: 'Parity title',
    },
  });
  const ad = await prisma.metaAd.create({
    data: {
      adAccountId: account.id,
      campaignId: campaign.id,
      adSetId: adSet.id,
      creativeId: creative.id,
      metaAdId: `ad-${suffix}`,
      name: 'Parity ad',
    },
  });

  await prisma.advertisingCampaign.create({
    data: { id: campaign.id, accountId: account.id, providerEntityId: campaign.metaCampaignId, name: campaign.name },
  });
  await prisma.advertisingGroup.create({
    data: {
      id: adSet.id,
      accountId: account.id,
      campaignId: campaign.id,
      providerEntityId: adSet.metaAdSetId,
      kind: 'AD_SET',
      name: adSet.name,
    },
  });
  await prisma.advertisingCreative.create({
    data: {
      id: creative.id,
      accountId: account.id,
      providerEntityId: creative.metaCreativeId,
      name: creative.name,
      title: creative.title,
    },
  });
  await prisma.advertisingAd.create({
    data: {
      id: ad.id,
      accountId: account.id,
      campaignId: campaign.id,
      groupId: adSet.id,
      creativeId: creative.id,
      providerEntityId: ad.metaAdId,
      name: ad.name,
    },
  });

  async function createPair(input: {
    date: string;
    spend: number;
    impressions: number;
    clicks: number;
    frequency: number;
    conversions: number;
    conversionValue: number;
  }) {
    const insight = await prisma.metaInsightDaily.create({
      data: {
        insightKey: `canonical-intelligence-${randomUUID()}`,
        adAccountId: account.id,
        campaignId: campaign.id,
        adSetId: adSet.id,
        adId: ad.id,
        creativeIdSnapshot: creative.id,
        level: 'AD',
        date: new Date(`${input.date}T00:00:00.000Z`),
        accountCurrency: 'USD',
        spend: input.spend,
        impressions: BigInt(input.impressions),
        clicks: BigInt(input.clicks),
        frequency: input.frequency,
        syncedAt: new Date(`${input.date}T12:00:00.000Z`),
      },
    });
    await prisma.advertisingDailyMetric.create({
      data: {
        id: insight.id,
        metricKey: `META:${insight.insightKey}`,
        accountId: account.id,
        campaignId: campaign.id,
        groupId: adSet.id,
        adId: ad.id,
        creativeIdSnapshot: creative.id,
        level: 'AD',
        date: insight.date,
        currency: 'USD',
        spend: input.spend,
        impressions: BigInt(input.impressions),
        clicks: BigInt(input.clicks),
        frequency: input.frequency,
        conversions: input.conversions,
        conversionValue: input.conversionValue,
        syncedAt: insight.syncedAt,
      },
    });
    return insight;
  }

  const currentA = await createPair({
    date: '2026-09-01', spend: 100, impressions: 1_000, clicks: 100, frequency: 1.5,
    conversions: 2, conversionValue: 240,
  });
  await addAction(currentA.id, 'ACTION', PURCHASE_ACTION_TYPE, 2);
  await addAction(currentA.id, 'ACTION_VALUE', PURCHASE_ACTION_TYPE, 240);

  const currentB = await createPair({
    date: '2026-09-02', spend: 50, impressions: 500, clicks: 25, frequency: 2,
    conversions: 1, conversionValue: 150,
  });
  await addAction(currentB.id, 'ACTION', 'omni_purchase', 1);
  await addAction(currentB.id, 'WEBSITE_PURCHASE_ROAS', 'omni_purchase', 3);

  const comparison = await createPair({
    date: '2026-08-31', spend: 80, impressions: 800, clicks: 40, frequency: 1.25,
    conversions: 3, conversionValue: 160,
  });
  await addAction(comparison.id, 'ACTION', 'purchase', 3);
  await addAction(comparison.id, 'PURCHASE_ROAS', 'purchase', 2);

  const productOnly = await createPair({
    date: '2026-08-20', spend: 40, impressions: 400, clicks: 20, frequency: 1.1,
    conversions: 1, conversionValue: 50,
  });
  await addAction(productOnly.id, 'ACTION', 'purchase', 1);
  await addAction(productOnly.id, 'ACTION_VALUE', 'purchase', 50);

  return { store };
}

async function cleanup(storeId: string) {
  await prisma.advertisingDailyMetric.deleteMany({ where: { account: { storeId } } });
  await prisma.advertisingAd.deleteMany({ where: { account: { storeId } } });
  await prisma.advertisingCreative.deleteMany({ where: { account: { storeId } } });
  await prisma.advertisingGroup.deleteMany({ where: { account: { storeId } } });
  await prisma.advertisingCampaign.deleteMany({ where: { account: { storeId } } });
  await prisma.advertisingAccount.deleteMany({ where: { storeId } });

  const accounts = await prisma.metaAdAccount.findMany({ where: { storeId }, select: { id: true } });
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length > 0) {
    await prisma.metaInsightAction.deleteMany({ where: { insight: { adAccountId: { in: accountIds } } } });
    await prisma.metaInsightDaily.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAd.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaCreative.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdSet.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaCampaign.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdAccount.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.metaConnection.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('canonical advertising intelligence parity', () => {
  it('preserves deterministic campaign and creative evidence for Meta', async () => {
    const { store } = await fixture();
    const legacy = new IntelligenceRepository();
    const canonical = new AdvertisingIntelligenceReadRepository();
    const selectedAccountIds = ['act_selected'];
    const productFrom = new Date('2026-08-10T00:00:00.000Z');
    const currentFrom = new Date('2026-09-01T00:00:00.000Z');
    const currentTo = new Date('2026-09-02T00:00:00.000Z');
    const comparisonFrom = new Date('2026-08-30T00:00:00.000Z');
    const comparisonTo = new Date('2026-08-31T00:00:00.000Z');

    const [legacyRows, canonicalRows] = await Promise.all([
      legacy.getMetaEvidenceRows({
        storeId: store.id,
        selectedAccountIds,
        productFrom,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
      canonical.getEvidenceRows({
        storeId: store.id,
        provider: 'META',
        selectedAccountExternalIds: selectedAccountIds,
        productFrom,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
    ]);

    const compatibilityRows = canonicalRows.map((row) => ({
      bucket: row.bucket,
      sourceRowCount: row.sourceRowCount,
      date: row.date,
      syncedAt: row.syncedAt,
      accountCurrency: row.currency ?? '',
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      frequency: row.frequency,
      campaign: row.campaign
        ? { id: row.campaign.id, metaCampaignId: row.campaign.externalId, name: row.campaign.name }
        : null,
      ad: row.ad
        ? {
            id: row.ad.id,
            metaAdId: row.ad.externalId,
            name: row.ad.name,
            creative: row.ad.creative
              ? {
                  id: row.ad.creative.id,
                  metaCreativeId: row.ad.creative.externalId,
                  name: row.ad.creative.name,
                  title: row.ad.creative.title,
                }
              : null,
          }
        : null,
      actions: [
        {
          kind: 'ACTION' as const,
          actionType: PURCHASE_ACTION_TYPE,
          actionDestination: null,
          value: row.conversions,
        },
        {
          kind: 'ACTION_VALUE' as const,
          actionType: PURCHASE_ACTION_TYPE,
          actionDestination: null,
          value: row.conversionValue,
        },
      ],
    }));

    expect(compatibilityRows).toEqual(legacyRows);
    expect(
      buildCampaignEvidence(compatibilityRows, currentFrom, currentTo, comparisonFrom, comparisonTo),
    ).toEqual(buildCampaignEvidence(legacyRows, currentFrom, currentTo, comparisonFrom, comparisonTo));
    expect(
      buildCreativeEvidence(compatibilityRows, currentFrom, currentTo, comparisonFrom, comparisonTo),
    ).toEqual(buildCreativeEvidence(legacyRows, currentFrom, currentTo, comparisonFrom, comparisonTo));
  });
});
