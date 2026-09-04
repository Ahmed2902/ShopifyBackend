import { describe, expect, it } from 'vitest';
import {
  buildProductAdsPeriod,
  resolveExactAdMappings,
} from '../../../src/modules/analytics/product-ads.metrics.js';

function mapping(input: {
  adId?: string;
  productId?: string;
  variantId?: string | null;
  confidence?: number;
  merchantConfirmed?: boolean;
  productDeletedAt?: Date | null;
}) {
  const adId = input.adId ?? 'ad-1';
  const productId = input.productId ?? 'product-1';
  return {
    id: `${adId}-${productId}-${input.variantId ?? 'product'}`,
    metaAdId: adId,
    productId,
    variantId: input.variantId ?? null,
    source: input.merchantConfirmed ? 'MANUAL' : 'URL',
    confidence: input.confidence ?? 0.9,
    isMerchantConfirmed: input.merchantConfirmed ?? false,
    product: {
      id: productId,
      shopifyProductId: `gid://shopify/Product/${productId}`,
      title: productId,
      status: 'ACTIVE',
      deletedAt: input.productDeletedAt ?? null,
    },
    variant:
      input.variantId === undefined || input.variantId === null
        ? null
        : {
            id: input.variantId,
            shopifyVariantId: `gid://shopify/ProductVariant/${input.variantId}`,
            title: input.variantId,
            sku: input.variantId,
          },
    ad: {
      id: adId,
      metaAdId: `meta-${adId}`,
      name: adId,
      effectiveStatus: 'ACTIVE',
      configuredStatus: 'ACTIVE',
      deletedAt: null,
      campaign: { id: 'campaign-1', metaCampaignId: 'meta-campaign-1', name: 'Campaign' },
      adSet: { id: 'adset-1', metaAdSetId: 'meta-adset-1', name: 'Ad Set' },
      creative: null,
    },
  };
}

function metaRow(input: { adId?: string; currency?: string; spend?: number }) {
  const adId = input.adId ?? 'ad-1';
  return {
    date: new Date('2026-09-01T00:00:00.000Z'),
    accountCurrency: input.currency ?? 'USD',
    spend: input.spend ?? 100,
    impressions: 1_000n,
    clicks: 100n,
    frequency: 1.5,
    objective: 'OUTCOME_SALES',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    attributionSetting: '7d_click_1d_view',
    syncedAt: new Date('2026-09-02T00:00:00.000Z'),
    campaign: { id: 'campaign-1', metaCampaignId: 'meta-campaign-1', name: 'Campaign' },
    adSet: { id: 'adset-1', metaAdSetId: 'meta-adset-1', name: 'Ad Set' },
    ad: {
      id: adId,
      metaAdId: `meta-${adId}`,
      name: adId,
      creative: null,
    },
    actions: [
      {
        kind: 'ACTION_VALUE',
        actionType: 'offsite_conversion.fb_pixel_purchase',
        actionDestination: null,
        value: 200,
      },
      {
        kind: 'ACTION',
        actionType: 'offsite_conversion.fb_pixel_purchase',
        actionDestination: null,
        value: 2,
      },
    ],
  };
}

describe('Product × Ads metrics', () => {
  it('keeps paid-only mapped products visible even with zero Shopify sales', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings: [mapping({})] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['mappings'],
      metaRows: [metaRow({})] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['metaRows'],
      storeCurrency: 'USD',
    });

    const product = result.products.get('product-1');
    expect(product).toBeDefined();
    expect(product?.commerce.netProductRevenue).toBe(0);
    expect(product?.advertising.spend).toBe(100);
    expect(product?.advertising.providerRoas).toBe(2);
    expect(product?.mapping.confidence).toBe(0.9);
    expect(result.totals.mappingCoverage).toBe(1);
  });

  it('keeps exact mapping metadata visible even when the selected period has no commerce or spend rows', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings: [mapping({})] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['mappings'],
      metaRows: [],
      storeCurrency: 'USD',
    });

    expect(result.products.get('product-1')).toMatchObject({
      product: { id: 'product-1' },
      commerce: { netProductRevenue: 0 },
      advertising: { spend: 0 },
      mapping: { confidence: 0.9, mappedAdCount: 1 },
    });
  });

  it('does not create a mapping-only analytics row for a later soft-deleted product', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings: [
        mapping({ productDeletedAt: new Date('2026-09-03T00:00:00.000Z') }),
      ] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['mappings'],
      metaRows: [],
      storeCurrency: 'USD',
    });

    expect(result.products.size).toBe(0);
  });

  it('still uses a deleted product mapping to resolve historical same-currency spend', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings: [
        mapping({ productDeletedAt: new Date('2026-09-03T00:00:00.000Z') }),
      ] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['mappings'],
      metaRows: [metaRow({ spend: 100 })] as unknown as Parameters<
        typeof buildProductAdsPeriod
      >[0]['metaRows'],
      storeCurrency: 'USD',
    });

    expect(result.totals.exactMappedSpend).toBe(100);
    expect(result.products.get('product-1')?.advertising.spend).toBe(100);
  });

  it('excludes ambiguous multi-product ads rather than splitting their spend', () => {
    const mappings = [
      mapping({ productId: 'product-1' }),
      mapping({ productId: 'product-2' }),
    ] as unknown as Parameters<typeof resolveExactAdMappings>[0];

    const resolution = resolveExactAdMappings(mappings);
    expect(resolution.exact.size).toBe(0);
    expect(resolution.ambiguousAdIds.has('ad-1')).toBe(true);

    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings,
      metaRows: [metaRow({})] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['metaRows'],
      storeCurrency: 'USD',
    });

    expect(result.totals.exactMappedSpend).toBe(0);
    expect(result.totals.unmappedSpend).toBe(100);
    expect(result.products.size).toBe(0);
  });

  it('lets merchant-confirmed mappings override conflicting automatic evidence', () => {
    const mappings = [
      mapping({ productId: 'product-1', confidence: 0.95 }),
      mapping({ productId: 'product-2', merchantConfirmed: true, confidence: 0.4 }),
    ] as unknown as Parameters<typeof resolveExactAdMappings>[0];

    const resolution = resolveExactAdMappings(mappings);
    const exact = resolution.exact.get('ad-1');

    expect(resolution.ambiguousAdIds.size).toBe(0);
    expect(exact?.productId).toBe('product-2');
    expect(exact?.confidence).toBe(1);
    expect(exact?.merchantConfirmed).toBe(true);
  });

  it('treats multiple variants of the same product as one exact product mapping', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings: [
        mapping({ variantId: 'variant-1' }),
        mapping({ variantId: 'variant-2' }),
      ] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['mappings'],
      metaRows: [metaRow({})] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['metaRows'],
      storeCurrency: 'USD',
    });

    expect(result.totals.exactMappedSpend).toBe(100);
    expect(result.products.get('product-1')?.advertising.spend).toBe(100);
    expect(result.products.get('product-1')?.mapping.mappedAdCount).toBe(1);
  });

  it('never mixes different Meta account currencies into one excluded-spend amount', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [],
      costRows: [],
      mappings: [mapping({})] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['mappings'],
      metaRows: [
        metaRow({ currency: 'USD', spend: 100 }),
        metaRow({ currency: 'EUR', spend: 50 }),
        metaRow({ currency: 'GBP', spend: 30 }),
      ] as unknown as Parameters<typeof buildProductAdsPeriod>[0]['metaRows'],
      storeCurrency: 'USD',
    });

    expect(result.totals.metaSpend).toBe(100);
    expect(result.totals.excludedMetaSpend).toEqual([
      { currency: 'EUR', spend: 50 },
      { currency: 'GBP', spend: 30 },
    ]);
    expect(result.products.get('product-1')?.advertising.spend).toBe(100);
  });
});
