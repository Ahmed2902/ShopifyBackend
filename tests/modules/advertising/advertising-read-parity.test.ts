import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { AdvertisingReadRepository } from '../../../src/modules/advertising/advertising-read.repository.js';
import { AdvertisingAnalyticsReadRepository } from '../../../src/modules/analytics/advertising-analytics.read.repository.js';
import { AdvertisingEntityAnalyticsReadRepository } from '../../../src/modules/analytics/advertising-entity-analytics.read.repository.js';
import { ProductAdsReadRepository } from '../../../src/modules/analytics/product-ads.read.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function addAction(
  insightId: string,
  kind: 'ACTION' | 'ACTION_VALUE' | 'PURCHASE_ROAS' | 'WEBSITE_PURCHASE_ROAS',
  actionType: string,
  value: number,
) {
  await prisma.metaInsightAction.create({
    data: {
      actionKey: `canonical-parity-action-${randomUUID()}`,
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
      name: 'Canonical paid media parity',
      myshopifyDomain: `canonical-parity-${suffix}.myshopify.com`,
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
      lastSyncedAt: new Date('2026-09-02T12:00:00.000Z'),
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

  await prisma.advertisingAccount.createMany({
    data: [
      {
        id: selected.id,
        storeId: store.id,
        provider: 'META',
        providerEntityId: selected.metaAccountId,
        name: selected.name,
        currency: selected.currency,
        lastSyncedAt: selected.lastSyncedAt,
      },
      {
        id: deselected.id,
        storeId: store.id,
        provider: 'META',
        providerEntityId: deselected.metaAccountId,
        name: deselected.name,
        currency: deselected.currency,
      },
    ],
  });

  const campaign = await prisma.metaCampaign.create({
    data: {
      adAccountId: selected.id,
      metaCampaignId: `campaign-${suffix}`,
      name: 'Parity campaign',
    },
  });
  const adSet = await prisma.metaAdSet.create({
    data: {
      adAccountId: selected.id,
      campaignId: campaign.id,
      metaAdSetId: `adset-${suffix}`,
      name: 'Parity ad set',
    },
  });
  const creative = await prisma.metaCreative.create({
    data: {
      adAccountId: selected.id,
      metaCreativeId: `creative-${suffix}`,
      name: 'Parity creative',
      title: 'Parity title',
    },
  });
  const ad = await prisma.metaAd.create({
    data: {
      adAccountId: selected.id,
      campaignId: campaign.id,
      adSetId: adSet.id,
      creativeId: creative.id,
      metaAdId: `ad-${suffix}`,
      name: 'Parity ad',
    },
  });

  await prisma.advertisingCampaign.create({
    data: {
      id: campaign.id,
      accountId: selected.id,
      providerEntityId: campaign.metaCampaignId,
      name: campaign.name,
    },
  });
  await prisma.advertisingGroup.create({
    data: {
      id: adSet.id,
      accountId: selected.id,
      campaignId: campaign.id,
      providerEntityId: adSet.metaAdSetId,
      kind: 'AD_SET',
      name: adSet.name,
    },
  });
  await prisma.advertisingCreative.create({
    data: {
      id: creative.id,
      accountId: selected.id,
      providerEntityId: creative.metaCreativeId,
      name: creative.name,
      title: creative.title,
    },
  });
  await prisma.advertisingAd.create({
    data: {
      id: ad.id,
      accountId: selected.id,
      campaignId: campaign.id,
      groupId: adSet.id,
      creativeId: creative.id,
      providerEntityId: ad.metaAdId,
      name: ad.name,
    },
  });

  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      shopifyProductId: `gid://shopify/Product/${suffix}`,
      title: 'Parity product',
      status: 'ACTIVE',
    },
  });
  const nativeMapping = await prisma.adProductMapping.create({
    data: {
      metaAdId: ad.id,
      productId: product.id,
      source: 'MANUAL',
      confidence: 0.9,
      isMerchantConfirmed: true,
    },
  });
  await prisma.advertisingProductMapping.create({
    data: {
      id: nativeMapping.id,
      adId: ad.id,
      productId: product.id,
      source: nativeMapping.source,
      confidence: nativeMapping.confidence,
      isMerchantConfirmed: nativeMapping.isMerchantConfirmed,
      validFrom: nativeMapping.validFrom,
    },
  });

  async function createPair(input: {
    adAccountId: string;
    date: string;
    currency?: string;
    level?: 'AD' | 'CAMPAIGN';
    spend: number;
    impressions: number;
    clicks: number;
    frequency?: number | null;
    conversions?: number;
    conversionValue?: number;
    cpa?: number | null;
    roas?: number | null;
    attributionSetting?: string | null;
    attachHierarchy?: boolean;
  }) {
    const native = await prisma.metaInsightDaily.create({
      data: {
        insightKey: `canonical-parity-${randomUUID()}`,
        adAccountId: input.adAccountId,
        campaignId: input.attachHierarchy === false ? null : campaign.id,
        adSetId: input.attachHierarchy === false ? null : adSet.id,
        adId: input.attachHierarchy === false ? null : ad.id,
        creativeIdSnapshot: input.attachHierarchy === false ? null : creative.id,
        level: input.level ?? 'AD',
        date: new Date(`${input.date}T00:00:00.000Z`),
        accountCurrency: input.currency ?? 'USD',
        spend: input.spend,
        impressions: BigInt(input.impressions),
        clicks: BigInt(input.clicks),
        frequency: input.frequency ?? null,
        attributionSetting: input.attributionSetting ?? null,
        syncedAt: new Date(`${input.date}T12:00:00.000Z`),
      },
    });

    await prisma.advertisingDailyMetric.create({
      data: {
        id: native.id,
        metricKey: `META:${native.insightKey}`,
        accountId: input.adAccountId,
        campaignId: input.attachHierarchy === false ? null : campaign.id,
        groupId: input.attachHierarchy === false ? null : adSet.id,
        adId: input.attachHierarchy === false ? null : ad.id,
        creativeIdSnapshot: input.attachHierarchy === false ? null : creative.id,
        level: input.level === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD',
        date: native.date,
        currency: input.currency ?? 'USD',
        spend: input.spend,
        impressions: BigInt(input.impressions),
        clicks: BigInt(input.clicks),
        frequency: input.frequency ?? null,
        conversions: input.conversions ?? 0,
        conversionValue: input.conversionValue ?? 0,
        cpa: input.cpa ?? null,
        roas: input.roas ?? null,
        providerMetrics: {
          attributionSetting: input.attributionSetting ?? null,
        },
        syncedAt: native.syncedAt,
      },
    });
    return native;
  }

  const currentDirect = await createPair({
    adAccountId: selected.id,
    date: '2026-09-01',
    spend: 100,
    impressions: 1_000,
    clicks: 100,
    frequency: 1.5,
    conversions: 2,
    conversionValue: 240,
    cpa: 50,
    roas: 2.4,
    attributionSetting: '7d_click_1d_view',
  });
  await addAction(currentDirect.id, 'ACTION', 'offsite_conversion.fb_pixel_purchase', 2);
  await addAction(currentDirect.id, 'ACTION', 'omni_purchase', 5);
  await addAction(currentDirect.id, 'ACTION', 'purchase', 9);
  await addAction(currentDirect.id, 'ACTION_VALUE', 'offsite_conversion.fb_pixel_purchase', 240);
  await addAction(currentDirect.id, 'ACTION_VALUE', 'purchase', 900);
  await addAction(currentDirect.id, 'WEBSITE_PURCHASE_ROAS', 'offsite_conversion.fb_pixel_purchase', 8);

  const currentFallback = await createPair({
    adAccountId: selected.id,
    date: '2026-09-02',
    spend: 50,
    impressions: 500,
    clicks: 25,
    frequency: 2,
    conversions: 1,
    conversionValue: 150,
    cpa: 50,
    roas: 3,
    attributionSetting: '1d_view',
  });
  await addAction(currentFallback.id, 'ACTION', 'omni_purchase', 1);
  await addAction(currentFallback.id, 'WEBSITE_PURCHASE_ROAS', 'omni_purchase', 3);
  await addAction(currentFallback.id, 'PURCHASE_ROAS', 'omni_purchase', 4);

  await createPair({
    adAccountId: selected.id,
    date: '2026-09-02',
    currency: 'EUR',
    spend: 20,
    impressions: 200,
    clicks: 10,
    frequency: 1.2,
    attributionSetting: '7d_click_1d_view',
  });

  const comparison = await createPair({
    adAccountId: selected.id,
    date: '2026-08-31',
    spend: 80,
    impressions: 800,
    clicks: 40,
    frequency: 1.25,
    conversions: 3,
    conversionValue: 160,
    cpa: 80 / 3,
    roas: 2,
    attributionSetting: '7d_click_1d_view',
  });
  await addAction(comparison.id, 'ACTION', 'purchase', 3);
  await addAction(comparison.id, 'ACTION_VALUE', 'purchase', 0);
  await addAction(comparison.id, 'WEBSITE_PURCHASE_ROAS', 'purchase', 0);
  await addAction(comparison.id, 'PURCHASE_ROAS', 'purchase', 2);

  await createPair({
    adAccountId: deselected.id,
    date: '2026-09-01',
    spend: 9_999,
    impressions: 99_999,
    clicks: 9_999,
    attachHierarchy: false,
  });
  await createPair({
    adAccountId: selected.id,
    date: '2026-09-01',
    level: 'CAMPAIGN',
    spend: 8_888,
    impressions: 88_888,
    clicks: 8_888,
  });
  await createPair({
    adAccountId: selected.id,
    date: '2026-08-20',
    spend: 7_777,
    impressions: 77_777,
    clicks: 7_777,
  });

  return { store, campaign, ad, product, selectedAccountIds: ['act_selected'] };
}

async function cleanup(storeId: string) {
  await prisma.advertisingProductMapping.deleteMany({ where: { ad: { account: { storeId } } } });
  await prisma.advertisingCollectionMapping.deleteMany({ where: { ad: { account: { storeId } } } });
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
    await prisma.adProductMapping.deleteMany({ where: { ad: { adAccountId: { in: accountIds } } } });
    await prisma.metaAd.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaCreative.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdSet.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaCampaign.deleteMany({ where: { adAccountId: { in: accountIds } } });
    await prisma.metaAdAccount.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.metaConnection.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) await cleanup(storeId);
});

describeDatabase('canonical advertising read parity', () => {
  it('matches Meta overview, entity, Product x Ads, and mapping semantics', async () => {
    const { store, campaign, ad, product, selectedAccountIds } = await fixture();
    const canonical = new AdvertisingReadRepository();
    const legacyOverview = new AdvertisingAnalyticsReadRepository();
    const legacyEntities = new AdvertisingEntityAnalyticsReadRepository();
    const legacyProductAds = new ProductAdsReadRepository();
    const currentFrom = new Date('2026-09-01T00:00:00.000Z');
    const currentTo = new Date('2026-09-02T00:00:00.000Z');
    const comparisonFrom = new Date('2026-08-30T00:00:00.000Z');
    const comparisonTo = new Date('2026-08-31T00:00:00.000Z');

    const [legacyOverviewRows, canonicalOverviewRows] = await Promise.all([
      legacyOverview.getOverviewAggregateRows({
        storeId: store.id,
        selectedAccountIds,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
      canonical.getOverviewAggregateRows({
        storeId: store.id,
        provider: 'META',
        selectedAccountExternalIds: selectedAccountIds,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
    ]);

    expect(
      canonicalOverviewRows.map((row) => ({
        period: row.period,
        accountCurrency: row.currency,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        purchases: row.conversions,
        purchaseValue: row.conversionValue,
        weightedFrequency: row.weightedFrequency,
        attributionSettings: row.attributionSettings,
      })),
    ).toEqual(legacyOverviewRows);

    const [legacyCampaignRows, canonicalCampaignRows] = await Promise.all([
      legacyEntities.getAggregateRows({
        storeId: store.id,
        selectedAccountIds,
        entityIds: [campaign.id],
        kind: 'CAMPAIGN',
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
      canonical.getEntityAggregateRows({
        storeId: store.id,
        provider: 'META',
        selectedAccountExternalIds: selectedAccountIds,
        entityIds: [campaign.id],
        kind: 'CAMPAIGN',
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
    ]);
    expect(
      canonicalCampaignRows.map((row) => ({
        period: row.period,
        entityId: row.entityId,
        accountCurrency: row.currency,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        purchases: row.conversions,
        purchaseValue: row.conversionValue,
        weightedFrequency: row.weightedFrequency,
      })),
    ).toEqual(legacyCampaignRows);

    const [legacyAdRows, canonicalAdRows] = await Promise.all([
      legacyProductAds.getMetaAdAggregates({
        storeId: store.id,
        selectedAccountIds,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
        adIds: [ad.id],
      }),
      canonical.getAdAggregateRows({
        storeId: store.id,
        provider: 'META',
        selectedAccountExternalIds: selectedAccountIds,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
        adIds: [ad.id],
      }),
    ]);
    expect(
      canonicalAdRows.map((row) => ({
        period: row.period,
        adId: row.adId,
        accountCurrency: row.currency,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        purchases: row.conversions,
        purchaseValue: row.conversionValue,
        weightedFrequency: row.weightedFrequency,
      })),
    ).toEqual(legacyAdRows);

    const [legacyMappings, canonicalMappings] = await Promise.all([
      legacyProductAds.getActiveMappingSummaries(store.id, selectedAccountIds),
      canonical.getActiveProductMappings({
        storeId: store.id,
        provider: 'META',
        selectedAccountExternalIds: selectedAccountIds,
      }),
    ]);
    expect(canonicalMappings).toHaveLength(1);
    expect(canonicalMappings[0]).toMatchObject({
      adId: ad.id,
      adExternalId: ad.metaAdId,
      productId: product.id,
      variantId: null,
      source: legacyMappings[0]?.source,
      isMerchantConfirmed: true,
      product: legacyMappings[0]?.product,
    });
    expect(Number(canonicalMappings[0]?.confidence)).toBe(Number(legacyMappings[0]?.confidence));
  });
});
