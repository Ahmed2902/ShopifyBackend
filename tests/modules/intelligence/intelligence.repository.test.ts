import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import {
  buildCampaignEvidence,
  buildCreativeEvidence,
  buildProductEvidence,
} from '../../../src/modules/intelligence/intelligence.metrics.js';
import { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';
import { buildSharedExposureEvidence } from '../../../src/modules/intelligence/shared-exposure.metrics.js';

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
      actionKey: `intelligence-action-${randomUUID()}`,
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
      name: 'Intelligence aggregate parity',
      myshopifyDomain: `intelligence-parity-${suffix}.myshopify.com`,
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
      targetScope: 'MULTI_PRODUCT',
      targetScopeConfidence: 0.9,
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
  await prisma.adProductMapping.create({
    data: {
      metaAdId: ad.id,
      productId: product.id,
      source: 'MANUAL',
      confidence: 0.9,
      isMerchantConfirmed: true,
    },
  });

  async function createInsight(input: {
    adAccountId: string;
    date: string;
    spend: number;
    impressions: number;
    clicks: number;
    frequency?: number | null;
    level?: 'AD' | 'CAMPAIGN';
    attachHierarchy?: boolean;
  }) {
    return prisma.metaInsightDaily.create({
      data: {
        insightKey: `intelligence-parity-${randomUUID()}`,
        adAccountId: input.adAccountId,
        campaignId: input.attachHierarchy === false ? null : campaign.id,
        adSetId: input.attachHierarchy === false ? null : adSet.id,
        adId: input.attachHierarchy === false ? null : ad.id,
        level: input.level ?? 'AD',
        date: new Date(`${input.date}T00:00:00.000Z`),
        accountCurrency: 'USD',
        spend: input.spend,
        impressions: BigInt(input.impressions),
        clicks: BigInt(input.clicks),
        frequency: input.frequency ?? null,
      },
    });
  }

  const currentDirect = await createInsight({
    adAccountId: selected.id,
    date: '2026-09-01',
    spend: 100,
    impressions: 1_000,
    clicks: 100,
    frequency: 1.5,
  });
  await addAction(currentDirect.id, 'ACTION', 'offsite_conversion.fb_pixel_purchase', 2);
  await addAction(currentDirect.id, 'ACTION', 'purchase', 9);
  await addAction(currentDirect.id, 'ACTION_VALUE', 'offsite_conversion.fb_pixel_purchase', 240);
  await addAction(currentDirect.id, 'ACTION_VALUE', 'purchase', 900);

  const currentFallback = await createInsight({
    adAccountId: selected.id,
    date: '2026-09-02',
    spend: 50,
    impressions: 500,
    clicks: 25,
    frequency: 2,
  });
  await addAction(currentFallback.id, 'ACTION', 'omni_purchase', 1);
  await addAction(currentFallback.id, 'WEBSITE_PURCHASE_ROAS', 'omni_purchase', 3);
  await addAction(currentFallback.id, 'PURCHASE_ROAS', 'omni_purchase', 4);

  const comparison = await createInsight({
    adAccountId: selected.id,
    date: '2026-08-31',
    spend: 80,
    impressions: 800,
    clicks: 40,
    frequency: 1.25,
  });
  await addAction(comparison.id, 'ACTION', 'purchase', 3);
  await addAction(comparison.id, 'ACTION_VALUE', 'purchase', 0);
  await addAction(comparison.id, 'WEBSITE_PURCHASE_ROAS', 'purchase', 0);
  await addAction(comparison.id, 'PURCHASE_ROAS', 'purchase', 2);

  const productOnly = await createInsight({
    adAccountId: selected.id,
    date: '2026-08-20',
    spend: 40,
    impressions: 400,
    clicks: 20,
    frequency: 1.1,
  });
  await addAction(productOnly.id, 'ACTION', 'purchase', 1);
  await addAction(productOnly.id, 'ACTION_VALUE', 'purchase', 50);

  // Selected-account, level, and product-window boundaries must remain hard filters.
  await createInsight({
    adAccountId: deselected.id,
    date: '2026-09-01',
    spend: 9_999,
    impressions: 99_999,
    clicks: 9_999,
    attachHierarchy: false,
  });
  await createInsight({
    adAccountId: selected.id,
    date: '2026-09-01',
    spend: 8_888,
    impressions: 88_888,
    clicks: 8_888,
    level: 'CAMPAIGN',
  });
  await createInsight({
    adAccountId: selected.id,
    date: '2026-08-01',
    spend: 7_777,
    impressions: 77_777,
    clicks: 7_777,
  });

  return {
    store,
    selectedAccountIds: ['act_selected'],
    ad,
    product,
  };
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

describeDatabase('IntelligenceRepository compact Meta evidence', () => {
  it('preserves campaign, creative, mapped-product, and shared-exposure rule evidence', async () => {
    const { store, selectedAccountIds, ad } = await fixture();
    const repository = new IntelligenceRepository();
    const productFrom = new Date('2026-08-10T00:00:00.000Z');
    const currentFrom = new Date('2026-09-01T00:00:00.000Z');
    const currentTo = new Date('2026-09-02T00:00:00.000Z');
    const comparisonFrom = new Date('2026-08-30T00:00:00.000Z');
    const comparisonTo = new Date('2026-08-31T00:00:00.000Z');

    const [rawRows, compactRows, mappings] = await Promise.all([
      repository.getMetaEvidenceRowsRaw(store.id, selectedAccountIds, productFrom, currentTo),
      repository.getMetaEvidenceRows({
        storeId: store.id,
        selectedAccountIds,
        productFrom,
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
      repository.getActiveProductMappings(store.id, selectedAccountIds),
    ]);

    expect(rawRows).toHaveLength(4);
    expect(compactRows).toHaveLength(3);
    expect(compactRows.reduce((sum, row) => sum + row.sourceRowCount, 0)).toBe(rawRows.length);

    const rawCampaigns = buildCampaignEvidence(
      rawRows as never,
      currentFrom,
      currentTo,
      comparisonFrom,
      comparisonTo,
    );
    const compactCampaigns = buildCampaignEvidence(
      compactRows,
      currentFrom,
      currentTo,
      comparisonFrom,
      comparisonTo,
    );
    expect(compactCampaigns).toEqual(rawCampaigns);
    expect(compactCampaigns[0]?.current).toMatchObject({
      spend: 150,
      purchases: 3,
      purchaseValue: 390,
    });
    expect(compactCampaigns[0]?.comparison).toMatchObject({
      spend: 80,
      purchases: 3,
      purchaseValue: 160,
    });

    expect(
      buildCreativeEvidence(compactRows, currentFrom, currentTo, comparisonFrom, comparisonTo),
    ).toEqual(
      buildCreativeEvidence(rawRows as never, currentFrom, currentTo, comparisonFrom, comparisonTo),
    );

    const productInput = {
      commerceRows: [],
      costRows: [],
      mappings,
      inventoryRows: [],
      storeCurrency: 'USD',
      inventoryTrusted: false,
      windowDays: 28,
    } as const;
    const rawProduct = buildProductEvidence({ ...productInput, metaRows: rawRows as never });
    const compactProduct = buildProductEvidence({ ...productInput, metaRows: compactRows });
    expect(compactProduct).toEqual(rawProduct);
    expect(compactProduct.totalMetaSpend).toBe(270);
    expect(compactProduct.exactMappedSpend).toBe(270);

    const targets = await repository.getSharedExposureTargets(store.id, selectedAccountIds, [ad.id]);
    const sharedInput = {
      targets,
      commerceRows: [],
      inventoryRows: [],
      inventoryTrusted: false,
      windowDays: 28,
    } as const;
    expect(buildSharedExposureEvidence({ ...sharedInput, metaRows: compactRows })).toEqual(
      buildSharedExposureEvidence({ ...sharedInput, metaRows: rawRows as never }),
    );
  });
});
