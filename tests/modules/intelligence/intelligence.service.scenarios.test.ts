import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceCommerceReadRepository } from '../../../src/modules/intelligence/intelligence-commerce.read.repository.js';
import type { IntelligenceContextReadRepository } from '../../../src/modules/intelligence/intelligence-context.read.repository.js';
import type { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';
import { recommendationDecision } from '../../../src/modules/intelligence/recommendation-decision.js';
import { IntelligenceService } from '../../../src/modules/intelligence/intelligence.service.js';
import type { IntelligenceSharedExposureReadRepository } from '../../../src/modules/intelligence/intelligence-shared-exposure.read.repository.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-14T12:00:00.000Z');
const currentDate = new Date('2026-09-10T00:00:00.000Z');
const comparisonDate = new Date('2026-09-03T00:00:00.000Z');
const purchaseActionType = 'offsite_conversion.fb_pixel_purchase';

type MetaScenarioInput = {
  id: string;
  name: string;
  spend: number;
  impressions?: number;
  clicks?: number;
  purchases?: number;
  purchaseValue?: number;
  frequency?: number;
  date: Date;
};

function metaRow(input: MetaScenarioInput) {
  return {
    bucket: input.date === currentDate ? 'CURRENT' : 'COMPARISON',
    sourceRowCount: 7,
    date: input.date,
    syncedAt: now,
    accountCurrency: 'GBP',
    spend: input.spend,
    impressions: input.impressions ?? 10_000,
    clicks: input.clicks ?? 250,
    frequency: input.frequency ?? 1.6,
    campaign: {
      id: `campaign-${input.id}`,
      metaCampaignId: `meta-campaign-${input.id}`,
      name: `SCN Campaign ${input.name}`,
    },
    ad: {
      id: `ad-${input.id}`,
      metaAdId: `meta-ad-${input.id}`,
      name: `SCN Ad ${input.name}`,
      creative: {
        id: `creative-${input.id}`,
        metaCreativeId: `meta-creative-${input.id}`,
        name: `SCN Creative ${input.name}`,
        title: null,
      },
    },
    actions: [
      {
        kind: 'ACTION' as const,
        actionType: purchaseActionType,
        actionDestination: null,
        value: input.purchases ?? 10,
      },
      {
        kind: 'ACTION_VALUE' as const,
        actionType: purchaseActionType,
        actionDestination: null,
        value: input.purchaseValue ?? input.spend * 3,
      },
    ],
  };
}

function stablePair(id: string, name: string, totalSpend: number, providerValue?: number) {
  const spend = totalSpend / 2;
  const value = providerValue === undefined ? spend * 3 : providerValue / 2;
  return [
    metaRow({ id, name, spend, date: comparisonDate, purchaseValue: value }),
    metaRow({ id, name, spend, date: currentDate, purchaseValue: value }),
  ];
}

const metaRows = [
  metaRow({
    id: 'mismatch',
    name: 'Mismatch + Fatigue',
    spend: 1_250,
    impressions: 20_000,
    clicks: 600,
    purchases: 40,
    purchaseValue: 5_000,
    frequency: 1.5,
    date: comparisonDate,
  }),
  metaRow({
    id: 'mismatch',
    name: 'Mismatch + Fatigue',
    spend: 1_750,
    impressions: 20_000,
    clicks: 400,
    purchases: 25,
    purchaseValue: 3_500,
    frequency: 2.3,
    date: currentDate,
  }),
  ...stablePair('underexposed', 'Underexposed Winner', 800),
  ...stablePair('margin', 'Margin Trap', 1_800, 5_760),
  ...stablePair('low-stock', 'Low Stock', 1_000),
  ...stablePair('neutral', 'Neutral Control', 2_400),
  ...stablePair('shared', 'Shared Products', 1_000),
];

const commerceRows = [
  {
    productId: 'product-underexposed',
    shopifyProductId: 'gid://shopify/Product/UNDEREXPOSED',
    title: 'SCN Underexposed Winner',
    sourceOrderLineCount: 20,
    soldUnits: 100,
    refundedUnits: 0,
    restockedUnits: 0,
    netUnits: 100,
    cogsUnits: 100,
    revenue: 35_000,
    refunds: 0,
    cogs: 15_000,
    costCoveredUnits: 100,
  },
  {
    productId: 'product-mismatch',
    shopifyProductId: 'gid://shopify/Product/MISMATCH',
    title: 'SCN Paid Mismatch',
    sourceOrderLineCount: 5,
    soldUnits: 15,
    refundedUnits: 0,
    restockedUnits: 0,
    netUnits: 15,
    cogsUnits: 15,
    revenue: 5_000,
    refunds: 0,
    cogs: 500,
    costCoveredUnits: 15,
  },
  {
    productId: 'product-margin',
    shopifyProductId: 'gid://shopify/Product/MARGIN',
    title: 'SCN Margin Trap',
    sourceOrderLineCount: 20,
    soldUnits: 100,
    refundedUnits: 0,
    restockedUnits: 0,
    netUnits: 100,
    cogsUnits: 100,
    revenue: 15_000,
    refunds: 0,
    cogs: 14_000,
    costCoveredUnits: 100,
  },
  {
    productId: 'product-low-stock',
    shopifyProductId: 'gid://shopify/Product/LOW_STOCK',
    title: 'SCN Low Stock',
    sourceOrderLineCount: 28,
    soldUnits: 140,
    refundedUnits: 0,
    restockedUnits: 0,
    netUnits: 140,
    cogsUnits: 140,
    revenue: 10_000,
    refunds: 0,
    cogs: 5_000,
    costCoveredUnits: 140,
  },
  {
    productId: 'product-neutral',
    shopifyProductId: 'gid://shopify/Product/NEUTRAL',
    title: 'SCN Neutral Control',
    sourceOrderLineCount: 20,
    soldUnits: 100,
    refundedUnits: 0,
    restockedUnits: 0,
    netUnits: 100,
    cogsUnits: 100,
    revenue: 35_000,
    refunds: 0,
    cogs: 15_000,
    costCoveredUnits: 100,
  },
];

const inventoryRows = commerceRows.map((row) => ({
  productId: row.productId,
  sourceInventoryLevelCount: 1,
  available: row.productId === 'product-low-stock' ? 20 : 500,
}));

function mapping(adId: string, productId: string, shopifyProductId: string, title: string) {
  return {
    metaAdId: `ad-${adId}`,
    productId,
    confidence: 0.95,
    isMerchantConfirmed: false,
    product: {
      id: productId,
      shopifyProductId,
      title,
    },
  };
}

const exactMappings = [
  mapping(
    'underexposed',
    'product-underexposed',
    'gid://shopify/Product/UNDEREXPOSED',
    'SCN Underexposed Winner',
  ),
  mapping(
    'mismatch',
    'product-mismatch',
    'gid://shopify/Product/MISMATCH',
    'SCN Paid Mismatch',
  ),
  mapping('margin', 'product-margin', 'gid://shopify/Product/MARGIN', 'SCN Margin Trap'),
  mapping(
    'low-stock',
    'product-low-stock',
    'gid://shopify/Product/LOW_STOCK',
    'SCN Low Stock',
  ),
  mapping(
    'neutral',
    'product-neutral',
    'gid://shopify/Product/NEUTRAL',
    'SCN Neutral Control',
  ),
];
const sharedMappings = [
  mapping(
    'shared',
    'product-low-stock',
    'gid://shopify/Product/LOW_STOCK',
    'SCN Low Stock',
  ),
  mapping(
    'shared',
    'product-neutral',
    'gid://shopify/Product/NEUTRAL',
    'SCN Neutral Control',
  ),
];

function storeContext(overrides: Record<string, unknown> = {}) {
  return {
    id: storeId,
    currencyCode: 'GBP',
    ianaTimezone: 'UTC',
    inventoryIntelligenceMode: 'TRUSTED',
    inventoryReviewedAt: now,
    shopifyConnection: {
      status: 'ACTIVE',
      scopes: ['read_orders', 'read_all_orders'],
      lastSyncedAt: now,
    },
    metaConnection: {
      status: 'ACTIVE',
      selectedAdAccountIds: ['act_scenario'],
    },
    successfulOrderHistorySync: {
      status: 'SUCCEEDED',
      recordsRead: 100,
      recordsWritten: 100,
      finishedAt: now,
    },
    latestMetaInsightSyncedAt: now,
    ...overrides,
  };
}

function buildService(
  input: {
    context?: ReturnType<typeof storeContext>;
    rows?: typeof metaRows;
    mappings?: typeof exactMappings;
    commerce?: typeof commerceRows;
    inventory?: typeof inventoryRows;
  } = {},
) {
  const repository = {
    getMetaEvidenceRows: vi.fn().mockResolvedValue(input.rows ?? metaRows),
    getActiveProductMappings: vi
      .fn()
      .mockResolvedValue(input.mappings ?? [...exactMappings, ...sharedMappings]),
    getSettings: vi.fn(),
    updateInventoryMode: vi.fn(),
  } as unknown as IntelligenceRepository;

  const commerceRead = {
    getProductEvidenceAggregates: vi.fn().mockResolvedValue(input.commerce ?? commerceRows),
    getInventoryEvidenceAggregates: vi.fn().mockResolvedValue(input.inventory ?? inventoryRows),
  } as unknown as IntelligenceCommerceReadRepository;

  const sharedRead = {
    getTargets: vi.fn().mockResolvedValue([
      {
        id: 'ad-shared',
        metaAdId: 'meta-ad-shared',
        name: 'SCN Shared Products',
        targetScope: 'MULTI_PRODUCT',
        targetScopeConfidence: 0.95,
        adAccount: { currency: 'GBP' },
        productMappings: [
          {
            productId: 'product-low-stock',
            confidence: 0.95,
            isMerchantConfirmed: false,
            product: {
              id: 'product-low-stock',
              shopifyProductId: 'gid://shopify/Product/LOW_STOCK',
              title: 'SCN Low Stock',
              deletedAt: null,
            },
          },
          {
            productId: 'product-neutral',
            confidence: 0.95,
            isMerchantConfirmed: false,
            product: {
              id: 'product-neutral',
              shopifyProductId: 'gid://shopify/Product/NEUTRAL',
              title: 'SCN Neutral Control',
              deletedAt: null,
            },
          },
        ],
        collectionMappings: [],
      },
    ]),
  } as unknown as IntelligenceSharedExposureReadRepository;

  const contextRead = {
    getContext: vi.fn().mockResolvedValue(input.context ?? storeContext()),
  } as unknown as IntelligenceContextReadRepository;

  return new IntelligenceService(repository, commerceRead, sharedRead, contextRead);
}

describe('IntelligenceService scenario harness', () => {
  it('turns normalized Meta + Shopify evidence into every current V1 recommendation family in one snapshot', async () => {
    const snapshot = await buildService().snapshot(storeId, now);
    const rules = new Set(snapshot.recommendations.map((recommendation) => recommendation.ruleId));

    expect(rules).toEqual(
      new Set([
        'campaign_efficiency_deterioration',
        'ad_efficiency_deterioration',
        'creative_fatigue_symptoms',
        'underexposed_commerce_winner',
        'paid_commerce_exposure_mismatch',
        'provider_roas_margin_trap',
        'inventory_spend_conflict',
        'shared_exposure_inventory_conflict',
      ]),
    );
    expect(snapshot.evidence).toMatchObject({
      campaigns: 6,
      creatives: 6,
      products: 5,
      sharedExposures: 1,
      mappingCoverage: 0.9,
      costCoverage: 1,
      shopifyCommerceUsable: true,
    });
    expect(snapshot.dataQuality.every((item) => item.status === 'HEALTHY')).toBe(true);

    const decisions = Object.fromEntries(
      snapshot.recommendations.map((recommendation) => [
        recommendation.ruleId,
        recommendationDecision(recommendation),
      ]),
    );
    expect(decisions).toMatchObject({
      campaign_efficiency_deterioration: {
        decisionAction: 'REDUCE',
        decisionConfidence: 'HIGH',
      },
      ad_efficiency_deterioration: {
        decisionAction: 'REDUCE',
        decisionConfidence: 'HIGH',
      },
      creative_fatigue_symptoms: { decisionAction: 'TEST', decisionConfidence: 'HIGH' },
      underexposed_commerce_winner: { decisionAction: 'TEST', decisionConfidence: 'HIGH' },
      paid_commerce_exposure_mismatch: {
        decisionAction: 'INVESTIGATE',
        decisionConfidence: 'HIGH',
      },
      provider_roas_margin_trap: { decisionAction: 'REDUCE', decisionConfidence: 'HIGH' },
      inventory_spend_conflict: { decisionAction: 'HOLD', decisionConfidence: 'MEDIUM' },
      shared_exposure_inventory_conflict: {
        decisionAction: 'HOLD',
        decisionConfidence: 'MEDIUM',
      },
    });
  });

  it('downgrades product recommendation confidence when global mapping coverage becomes very low', async () => {
    const onlyUnderexposed = exactMappings.filter(
      (row) => row.productId === 'product-underexposed',
    );
    const snapshot = await buildService({ mappings: onlyUnderexposed }).snapshot(storeId, now);
    const underexposed = snapshot.recommendations.find(
      (recommendation) => recommendation.ruleId === 'underexposed_commerce_winner',
    );

    expect(underexposed).toBeDefined();
    expect(underexposed?.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MAPPING_COVERAGE_VERY_LOW' }),
        expect.objectContaining({ code: 'PRODUCT_AD_MAPPING_LOW' }),
      ]),
    );
    expect(recommendationDecision(underexposed!).decisionConfidence).toBe('LOW');
  });

  it('adds freshness limitations and lowers confidence without changing the deterministic rule identity', async () => {
    const stale = new Date(now.getTime() - 72 * 60 * 60 * 1_000);
    const context = storeContext({
      shopifyConnection: {
        status: 'ACTIVE',
        scopes: ['read_orders', 'read_all_orders'],
        lastSyncedAt: stale,
      },
      latestMetaInsightSyncedAt: stale,
    });
    const snapshot = await buildService({ context }).snapshot(storeId, now);
    const mismatch = snapshot.recommendations.find(
      (recommendation) => recommendation.ruleId === 'paid_commerce_exposure_mismatch',
    );

    expect(snapshot.dataQuality).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SHOPIFY_SYNC_STALE', status: 'WARNING' }),
        expect.objectContaining({ code: 'META_SYNC_STALE', status: 'WARNING' }),
      ]),
    );
    expect(mismatch?.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SHOPIFY_SYNC_STALE' }),
        expect.objectContaining({ code: 'META_SYNC_STALE' }),
      ]),
    );
    const decision = recommendationDecision(mismatch!);
    expect(decision.decisionAction).toBe('INVESTIGATE');
    expect(decision.decisionConfidence).toBe('MEDIUM');
  });
});