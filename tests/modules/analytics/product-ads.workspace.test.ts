import { describe, expect, it, vi } from 'vitest';
import type { AdvertisingAnalyticsRepository } from '../../../src/modules/analytics/advertising-analytics.repository.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { ProductAdsRepository } from '../../../src/modules/analytics/product-ads.repository.js';
import { ProductAdsWorkspace } from '../../../src/modules/analytics/product-ads.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = new Date('2026-09-04T12:00:00.000Z');

function metaRow(date: string, spend: number) {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    accountCurrency: 'USD',
    spend,
    impressions: 1_000n,
    clicks: 100n,
    frequency: 1.5,
    objective: 'OUTCOME_SALES',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    attributionSetting: '7d_click_1d_view',
    syncedAt: now,
    campaign: { id: 'campaign-1', metaCampaignId: 'meta-campaign-1', name: 'Campaign' },
    adSet: { id: 'adset-1', metaAdSetId: 'meta-adset-1', name: 'Ad Set' },
    ad: {
      id: 'ad-1',
      metaAdId: 'meta-ad-1',
      name: 'Ad 1',
      creative: null,
    },
    actions: [],
  };
}

function mapping(variantId: string) {
  return {
    id: `mapping-${variantId}`,
    metaAdId: 'ad-1',
    productId,
    variantId,
    source: 'URL',
    confidence: 0.9,
    isMerchantConfirmed: false,
    product: {
      id: productId,
      shopifyProductId: 'gid://shopify/Product/1',
      title: 'Core Tee',
      status: 'ACTIVE',
    },
    variant: {
      id: variantId,
      shopifyVariantId: `gid://shopify/ProductVariant/${variantId}`,
      title: variantId,
      sku: variantId,
    },
    ad: {
      id: 'ad-1',
      metaAdId: 'meta-ad-1',
      name: 'Ad 1',
      effectiveStatus: 'ACTIVE',
      configuredStatus: 'ACTIVE',
      campaign: { id: 'campaign-1', metaCampaignId: 'meta-campaign-1', name: 'Campaign' },
      adSet: { id: 'adset-1', metaAdSetId: 'meta-adset-1', name: 'Ad Set' },
      creative: null,
    },
  };
}

function analyticsRepository() {
  return {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: { status: 'ACTIVE', scopes: ['read_orders'], lastSyncedAt: now },
      metaConnection: { status: 'ACTIVE', selectedAdAccountIds: ['act_1'] },
    }),
    getCommerceRows: vi.fn().mockResolvedValue([]),
    getMetaRows: vi.fn().mockResolvedValue([
      metaRow('2026-09-02', 100),
      metaRow('2026-08-26', 50),
    ]),
    getVariantCosts: vi.fn().mockResolvedValue([]),
    getProduct: vi.fn().mockResolvedValue({
      id: productId,
      shopifyProductId: 'gid://shopify/Product/1',
      title: 'Core Tee',
      status: 'ACTIVE',
      variants: [],
      collections: [],
    }),
  } as unknown as AnalyticsRepository;
}

function productAdsRepository() {
  return {
    getActiveMappings: vi.fn().mockResolvedValue([mapping('variant-1'), mapping('variant-2')]),
  } as unknown as ProductAdsRepository;
}

describe('ProductAdsWorkspace', () => {
  it('returns one stable cross-channel product resource with current/comparison evidence', async () => {
    const mappings = productAdsRepository();
    const workspace = new ProductAdsWorkspace(analyticsRepository(), mappings);

    const result = await workspace.list(storeId, { days: 7, page: 1, limit: 50 }, now);

    expect(mappings.getActiveMappings).toHaveBeenCalledWith(storeId, ['act_1']);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      product: { id: productId, title: 'Core Tee' },
      mapping: { confidence: 0.9, mappedAdCount: 1 },
      current: { advertising: { spend: 100 } },
      comparison: { advertising: { spend: 50 } },
    });
    expect(result.summary.current.mappingCoverage).toBe(1);
    expect(result.summary.comparison.mappingCoverage).toBe(1);
  });

  it('exposes exact ad mapping evidence once while preserving same-product variants', async () => {
    const workspace = new ProductAdsWorkspace(analyticsRepository(), productAdsRepository());

    const result = await workspace.detail(storeId, productId, { days: 7 }, now);

    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]?.ad).toMatchObject({ id: 'ad-1', name: 'Ad 1' });
    expect(result.mappings[0]?.variants).toHaveLength(2);
  });

  it('uses the injected canonical advertising repository instead of the commerce repository for paid facts', async () => {
    const commerce = analyticsRepository();
    const canonicalGetMetaRows = vi.fn().mockResolvedValue([
      metaRow('2026-09-02', 125),
      metaRow('2026-08-26', 40),
    ]);
    const advertising = {
      getMetaRows: canonicalGetMetaRows,
    } as unknown as AdvertisingAnalyticsRepository;
    const workspace = new ProductAdsWorkspace(commerce, productAdsRepository(), advertising);

    const result = await workspace.list(storeId, { days: 7, page: 1, limit: 50 }, now);

    expect(commerce.getMetaRows).not.toHaveBeenCalled();
    expect(canonicalGetMetaRows).toHaveBeenCalledWith(
      storeId,
      ['act_1'],
      expect.any(Date),
      expect.any(Date),
    );
    expect(result.items[0]).toMatchObject({
      current: { advertising: { spend: 125 } },
      comparison: { advertising: { spend: 40 } },
    });
  });
});
