import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { AdExposureRepository } from '../../../src/modules/analytics/ad-exposure.repository.js';
import { AdExposureWorkspace } from '../../../src/modules/analytics/ad-exposure.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const adId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const productB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const collectionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const now = new Date('2026-09-04T12:00:00.000Z');
const query = { days: 7, page: 1, limit: 50 } as const;

function metaRow(date: string) {
  return {
    date: new Date(date),
    accountCurrency: 'USD',
    spend: 300,
    impressions: BigInt(12_000),
    clicks: BigInt(300),
    frequency: 1.8,
    objective: 'OUTCOME_SALES',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    attributionSetting: null,
    syncedAt: new Date('2026-09-04T06:00:00.000Z'),
    campaign: { id: 'campaign', metaCampaignId: 'meta-campaign', name: 'Campaign' },
    adSet: { id: 'adset', metaAdSetId: 'meta-adset', name: 'Ad set' },
    ad: {
      id: adId,
      metaAdId: 'meta-ad',
      name: 'Outfit ad',
      creative: { id: 'creative', metaCreativeId: 'meta-creative', name: 'Creative', title: null },
    },
    actions: [],
  };
}

function product(id: string, shopifyProductId: string, title: string) {
  return { id, shopifyProductId, title, status: 'ACTIVE', deletedAt: null };
}

function multiProductAd() {
  return {
    id: adId,
    metaAdId: 'meta-ad',
    name: 'Outfit ad',
    configuredStatus: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    targetScope: 'MULTI_PRODUCT' as const,
    targetScopeConfidence: 0.95,
    targetScopeEvidence: { matchedBy: 'structured_catalog_identifier' },
    adAccount: { metaAccountId: 'act-1', currency: 'USD' },
    campaign: { id: 'campaign', metaCampaignId: 'meta-campaign', name: 'Campaign' },
    adSet: { id: 'adset', metaAdSetId: 'meta-adset', name: 'Ad set' },
    creative: { id: 'creative', metaCreativeId: 'meta-creative', name: 'Creative', title: null, thumbnailUrl: null },
    productMappings: [
      {
        id: 'map-a',
        productId: productA,
        variantId: null,
        granularity: 'PRODUCT' as const,
        source: 'CATALOG_ITEM' as const,
        confidence: 0.95,
        evidenceJson: {},
        landingUrl: null,
        isMerchantConfirmed: false,
        product: product(productA, 'shopify-a', 'Pants'),
        variant: null,
      },
      {
        id: 'map-b',
        productId: productB,
        variantId: null,
        granularity: 'PRODUCT' as const,
        source: 'CATALOG_ITEM' as const,
        confidence: 0.95,
        evidenceJson: {},
        landingUrl: null,
        isMerchantConfirmed: false,
        product: product(productB, 'shopify-b', 'Shirt'),
        variant: null,
      },
    ],
    collectionMappings: [],
  };
}

function build(ad = multiProductAd()) {
  const analyticsRepository = {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'TRUSTED',
      shopifyConnection: null,
      metaConnection: { status: 'ACTIVE', selectedAdAccountIds: ['act-1'] },
    }),
    getMetaRows: vi.fn().mockResolvedValue([metaRow('2026-09-01T00:00:00.000Z')]),
    getCommerceRows: vi.fn().mockResolvedValue([
      {
        productId: productA,
        variantId: null,
        quantity: 14,
        currentQuantity: 14,
        discountedTotal: 500,
        order: {
          id: 'order-a',
          shopifyCreatedAt: new Date('2026-09-01T00:00:00.000Z'),
          processedAt: new Date('2026-09-01T00:00:00.000Z'),
          currencyCode: 'USD',
        },
        product: product(productA, 'shopify-a', 'Pants'),
        variant: null,
        refundLines: [],
      },
    ]),
  } as unknown as AnalyticsRepository;

  const repository = {
    getAdsPage: vi.fn().mockResolvedValue({ total: 1, items: [ad] }),
    getAd: vi.fn().mockResolvedValue(ad),
    getInventoryForProducts: vi.fn().mockResolvedValue([
      {
        available: 8,
        incoming: 0,
        committed: 0,
        onHand: 8,
        inventoryItem: { variant: { id: 'variant-a', productId: productA } },
      },
      {
        available: 80,
        incoming: 0,
        committed: 0,
        onHand: 80,
        inventoryItem: { variant: { id: 'variant-b', productId: productB } },
      },
    ]),
  } as unknown as AdExposureRepository;

  return {
    analyticsRepository,
    repository,
    workspace: new AdExposureWorkspace(analyticsRepository, repository),
  };
}

describe('AdExposureWorkspace', () => {
  it('keeps multi-product spend at ad level and never divides it between promoted products', async () => {
    const { workspace } = build();

    const result = await workspace.list(storeId, query, now);
    const item = result.items[0]!;

    expect(item.scope).toMatchObject({
      type: 'MULTI_PRODUCT',
      attributionPrecision: 'SHARED_MULTI_PRODUCT',
    });
    expect(item.current.spend).toBe(300);
    expect(item.targets.products).toHaveLength(2);
    expect(item.targets.products.every((target) => target.allocatedAdSpend === null)).toBe(true);
    expect(item.limitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SHARED_SPEND_NOT_ALLOCATED' })]),
    );
  });

  it('marks product scope unresolved when no current Shopify target remains', async () => {
    const base = multiProductAd();
    const unresolvedAd = {
      ...base,
      targetScope: 'PRODUCT' as const,
      targetScopeConfidence: 1,
      productMappings: [],
    };
    const { workspace } = build(unresolvedAd);

    const result = await workspace.list(storeId, query, now);
    const item = result.items[0]!;

    expect(item.targets.products).toEqual([]);
    expect(item.scope).toMatchObject({
      type: 'PRODUCT',
      attributionPrecision: 'EXACT_PRODUCT',
      evidenceQuality: 'MEDIUM',
    });
    expect(item.limitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TARGET_UNRESOLVED' })]),
    );
  });

  it('preserves the promoted variant identity for variant-scoped exposure', async () => {
    const base = multiProductAd();
    const variant = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      shopifyVariantId: 'shopify-variant-a',
      title: 'Black / Large',
      sku: 'PANTS-BLK-L',
      deletedAt: null,
    };
    const variantAd = {
      ...base,
      targetScope: 'VARIANT' as const,
      targetScopeConfidence: 1,
      productMappings: [
        {
          ...base.productMappings[0]!,
          variantId: variant.id,
          granularity: 'VARIANT' as const,
          confidence: 1,
          isMerchantConfirmed: true,
          variant,
        },
      ],
    };
    const { workspace } = build(variantAd);

    const result = await workspace.list(storeId, query, now);
    const target = result.items[0]!.targets.products[0]!;

    expect(result.items[0]!.scope).toMatchObject({
      type: 'VARIANT',
      attributionPrecision: 'EXACT_PRODUCT',
    });
    expect(target.variants).toEqual([
      expect.objectContaining({
        id: variant.id,
        shopifyVariantId: 'shopify-variant-a',
        sku: 'PANTS-BLK-L',
      }),
    ]);
    expect(target.allocatedAdSpend).toBe(300);
  });

  it('preserves the selected option subset for product-option exposure', async () => {
    const base = multiProductAd();
    const optionSelector = { Color: ['Black'], Size: ['Large', 'XL'] };
    const optionAd = {
      ...base,
      targetScope: 'PRODUCT_OPTION' as const,
      targetScopeConfidence: 1,
      productMappings: [
        {
          ...base.productMappings[0]!,
          granularity: 'PRODUCT_OPTION' as const,
          optionSelector,
          confidence: 1,
          isMerchantConfirmed: true,
        },
      ],
    };
    const { workspace } = build(optionAd);

    const result = await workspace.list(storeId, query, now);
    const target = result.items[0]!.targets.products[0]!;

    expect(result.items[0]!.scope).toMatchObject({
      type: 'PRODUCT_OPTION',
      attributionPrecision: 'EXACT_PRODUCT',
    });
    expect(target.optionSelectors).toEqual([optionSelector]);
    expect(target.variants).toEqual([]);
    expect(target.allocatedAdSpend).toBe(300);
  });

  it('exposes trusted deterministic days cover without turning it into a forecast', async () => {
    const { workspace } = build();

    const result = await workspace.detail(storeId, adId, { days: 7 }, now);
    const pants = result.targets.products.find((target) => target.product?.id === productA)!;

    expect(pants.recentObservedUnitsPerDay).toBe(2);
    expect(pants.daysCover).toBe(4);
    expect(result.methodology.inventory).toBe(
      'CURRENT_AVAILABLE_DIVIDED_BY_OBSERVED_STOCK_DEPLETION_RATE',
    );
    expect(result.methodology.prediction).toBe('NONE');
  });

  it('represents collection membership as shared exposure with explicit current-membership limits', async () => {
    const base = multiProductAd();
    const collectionAd = {
      ...base,
      targetScope: 'COLLECTION' as const,
      targetScopeConfidence: 1,
      targetScopeEvidence: { source: 'merchant_confirmation' },
      productMappings: [],
      collectionMappings: [
        {
          id: 'collection-map',
          collectionId,
          source: 'MANUAL' as const,
          confidence: 1,
          evidenceJson: {},
          landingUrl: 'https://store.test/collections/summer-drop',
          isMerchantConfirmed: true,
          collection: {
            id: collectionId,
            shopifyCollectionId: 'shopify-collection',
            title: 'Summer Drop',
            handle: 'summer-drop',
            deletedAt: null,
            _count: { products: 2 },
            products: [
              { position: 1, product: product(productA, 'shopify-a', 'Pants') },
              { position: 2, product: product(productB, 'shopify-b', 'Shirt') },
            ],
          },
        },
      ],
    };
    const { workspace } = build(collectionAd);

    const result = await workspace.list(storeId, query, now);
    const item = result.items[0]!;

    expect(item.scope).toMatchObject({
      type: 'COLLECTION',
      merchantConfirmed: true,
      attributionPrecision: 'COLLECTION',
    });
    expect(item.targets.collections[0]).toMatchObject({
      id: collectionId,
      title: 'Summer Drop',
      productCount: 2,
    });
    expect(item.targets.products.every((target) => target.allocatedAdSpend === null)).toBe(true);
    expect(item.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CURRENT_COLLECTION_MEMBERSHIP' }),
        expect.objectContaining({ code: 'SHARED_SPEND_NOT_ALLOCATED' }),
      ]),
    );
  });
});
