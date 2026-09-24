import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProductAdsWorkspace } from '../../../src/modules/analytics/product-ads.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const canonicalAccountId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const adId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const now = new Date('2026-09-04T12:00:00.000Z');

function unifiedResult(input?: { comparisonEvidence?: boolean }) {
  const comparisonEvidence = input?.comparisonEvidence ?? true;
  const summaryPeriod = (current: boolean) => ({
    evidenceAvailable: current || comparisonEvidence,
    compatiblePaidSpend: current ? 200 : comparisonEvidence ? 100 : null,
    exactMappedSpend: current ? 100 : comparisonEvidence ? 50 : 0,
    sharedSpend: 0,
    ambiguousObservedSpend: 0,
    unmappedSpend: current ? 100 : comparisonEvidence ? 50 : null,
    mappingCoverage: current ? 0.5 : comparisonEvidence ? 0.5 : null,
    missingAccountIds: comparisonEvidence || current ? [] : [canonicalAccountId],
    exactMappedSpendByProvider: { META: current ? 100 : comparisonEvidence ? 50 : 0 },
  });
  const commerce = (current: boolean) => ({
    evidenceAvailable: true,
    orderCount: 2,
    soldUnits: 4,
    refundedUnits: 0,
    netUnits: 4,
    productRevenue: current ? 400 : 200,
    refunds: 0,
    netProductRevenue: current ? 400 : 200,
    cogs: current ? 100 : 50,
    costCoverage: 1,
    contributionBeforeAds: current ? 300 : 150,
  });
  const advertising = (current: boolean) => ({
    evidenceAvailable: current || comparisonEvidence,
    spend: current ? 100 : comparisonEvidence ? 50 : null,
    impressions: current ? 1000 : comparisonEvidence ? 500 : null,
    clicks: current ? 100 : comparisonEvidence ? 50 : null,
    providerConversions: current ? 10 : comparisonEvidence ? 5 : null,
    providerConversionValue: current ? 300 : comparisonEvidence ? 150 : null,
    byProvider: [],
  });
  const item = {
    product: {
      id: productId,
      shopifyProductId: 'gid://shopify/Product/1',
      title: 'Core Tee',
      status: 'ACTIVE',
    },
    mapping: {
      confidence: 0.9,
      merchantConfirmed: false,
      exactMappedAdCount: 1,
      limitations: [],
      evidence: [
        {
          provider: 'META',
          account: {
            id: canonicalAccountId,
            provider: 'META',
            providerEntityId: 'act_1',
            name: 'Meta account',
            currency: 'USD',
          },
          mappingType: 'EXACT',
          granularity: 'PRODUCT',
          source: 'URL',
          confidence: 0.9,
          evidence: null,
          validity: { from: now, until: null },
          merchantConfirmed: false,
          ad: {
            id: adId,
            providerEntityId: 'meta-ad-1',
            name: 'Ad 1',
            targetScope: 'SINGLE_PRODUCT',
          },
          campaign: {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            providerEntityId: 'meta-campaign-1',
            name: 'Campaign',
          },
          group: {
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            providerEntityId: 'meta-adset-1',
            kind: 'AD_SET',
            name: 'Ad Set',
          },
        },
      ],
    },
    current: {
      commerce: commerce(true),
      advertising: advertising(true),
      storefront: {},
      inventory: {},
      intelligence: { contributionAfterAds: 200 },
    },
    comparison: {
      commerce: commerce(false),
      advertising: advertising(false),
      storefront: {},
      intelligence: { contributionAfterAds: comparisonEvidence ? 100 : null },
    },
    change: {},
  };
  return {
    schemaVersion: '2.0',
    filters: { provider: 'META', accountId: canonicalAccountId, currency: null },
    window: {
      current: { from: '2026-08-29', to: '2026-09-04' },
      comparison: { from: '2026-08-22', to: '2026-08-28' },
      days: 7,
    },
    currency: 'USD',
    truthModel: {},
    mappingPolicy: {},
    methodology: {},
    summary: {
      current: summaryPeriod(true),
      comparison: summaryPeriod(false),
      change: {},
    },
    items: [item],
    pagination: { page: 1, limit: 50, total: 1, pages: 1 },
    ...item,
  };
}

function dependencies(input?: { comparisonEvidence?: boolean }) {
  const result = unifiedResult(input);
  const analytics = {
    getStoreContext: vi.fn(async () => ({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: null,
      metaConnection: { status: 'ACTIVE', selectedAdAccountIds: ['act_1'] },
    })),
  };
  const advertising = {
    connectionStates: vi.fn(async () => [
      {
        provider: 'META', status: 'ACTIVE', selectedExternalIds: ['act_1'],
        lastSyncedAt: now, lastSyncStatus: 'SUCCEEDED',
      },
    ]),
    selectedAccounts: vi.fn(async () => [
      {
        id: canonicalAccountId,
        provider: 'META',
        providerEntityId: 'act_1',
        name: 'Meta account',
        status: 'ACTIVE',
        currency: 'USD',
        timezone: 'UTC',
        lastSyncedAt: now,
      },
    ]),
  };
  const unified = {
    list: vi.fn(async () => result),
    detail: vi.fn(async () => result),
  };
  const mappings = {
    activeMappings: vi.fn(async () => [
      {
        id: 'mapping-1', adId, productId, variantId: 'variant-1', granularity: 'VARIANT',
        source: 'URL', confidence: 0.9, evidence: null, landingUrl: null,
        providerProductId: null, providerProductGroupId: null, merchantConfirmed: false,
        validFrom: now, validUntil: null,
        ad: {
          id: adId, providerEntityId: 'meta-ad-1', name: 'Ad 1', targetScope: 'SINGLE_PRODUCT',
          targetScopeConfidence: 0.9, targetScopeEvidence: null,
          account: { id: canonicalAccountId, provider: 'META', providerEntityId: 'act_1', name: 'Meta account', currency: 'USD' },
          campaign: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', providerEntityId: 'meta-campaign-1', name: 'Campaign' },
          group: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', providerEntityId: 'meta-adset-1', kind: 'AD_SET', name: 'Ad Set' },
        },
        product: { id: productId, shopifyProductId: 'gid://shopify/Product/1', title: 'Core Tee', status: 'ACTIVE', deletedAt: null },
        variant: { id: 'variant-1', shopifyVariantId: 'gid://shopify/ProductVariant/1', title: 'Small', sku: 'S' },
        collectionMappingCount: 0,
      },
      {
        id: 'mapping-2', adId, productId, variantId: 'variant-2', granularity: 'VARIANT',
        source: 'URL', confidence: 0.9, evidence: null, landingUrl: null,
        providerProductId: null, providerProductGroupId: null, merchantConfirmed: false,
        validFrom: now, validUntil: null,
        ad: {
          id: adId, providerEntityId: 'meta-ad-1', name: 'Ad 1', targetScope: 'SINGLE_PRODUCT',
          targetScopeConfidence: 0.9, targetScopeEvidence: null,
          account: { id: canonicalAccountId, provider: 'META', providerEntityId: 'act_1', name: 'Meta account', currency: 'USD' },
          campaign: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', providerEntityId: 'meta-campaign-1', name: 'Campaign' },
          group: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', providerEntityId: 'meta-adset-1', kind: 'AD_SET', name: 'Ad Set' },
        },
        product: { id: productId, shopifyProductId: 'gid://shopify/Product/1', title: 'Core Tee', status: 'ACTIVE', deletedAt: null },
        variant: { id: 'variant-2', shopifyVariantId: 'gid://shopify/ProductVariant/2', title: 'Large', sku: 'L' },
        collectionMappingCount: 0,
      },
    ]),
  };
  const compatibility = {
    netProductRevenueTotals: vi.fn(async () => ({ CURRENT: 1000, COMPARISON: 500 })),
  };
  const workspace = new ProductAdsWorkspace(
    analytics as never,
    advertising as never,
    unified as never,
    mappings as never,
    compatibility as never,
  );
  return { workspace, analytics, advertising, unified, mappings, compatibility };
}

describe('ProductAdsWorkspace unified compatibility adapter', () => {
  it('translates the legacy Meta external account id and preserves list response semantics', async () => {
    const { workspace, unified } = dependencies();

    const result = await workspace.list(
      storeId,
      { days: 7, page: 1, limit: 50, accountId: 'act_1' },
      now,
    );

    expect(unified.list).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        provider: 'META',
        accountId: canonicalAccountId,
        days: 7,
        page: 1,
        limit: 50,
      }),
      now,
    );
    expect(result.compatibility).toMatchObject({
      deprecated: true,
      authoritativeEndpoint: '/analytics/product-ads/unified',
      computation: 'UNIFIED_PRODUCT_ADS_SERVICE',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      product: { id: productId, title: 'Core Tee' },
      mapping: { confidence: 0.9, mappedAdCount: 1, sources: ['URL'] },
      current: {
        advertising: { evidenceAvailable: true, sourceRows: 1, spend: 100 },
        derived: { revenueShare: 0.4, mappedSpendShare: 0.5 },
      },
      comparison: {
        advertising: { evidenceAvailable: true, sourceRows: 1, spend: 50 },
        derived: { revenueShare: 0.4, mappedSpendShare: 0.5 },
      },
    });
    expect(result.summary.current).toMatchObject({
      evidenceAvailable: true,
      netProductRevenue: 1000,
      metaSpend: 200,
      exactMappedSpend: 100,
      mappingCoverage: 0.5,
    });
  });

  it('fails closed when comparison paid evidence is missing instead of treating zero as fact', async () => {
    const { workspace } = dependencies({ comparisonEvidence: false });

    const result = await workspace.list(storeId, { days: 7, page: 1, limit: 50 }, now);

    expect(result.summary.comparison).toMatchObject({
      evidenceAvailable: false,
      metaSpend: 0,
      unmappedSpend: 0,
    });
    expect(result.summary.change.metaSpend).toBeNull();
    expect(result.summary.change.unmappedSpend).toBeNull();
    expect(result.items[0]?.comparison.advertising).toMatchObject({
      evidenceAvailable: false,
      sourceRows: 0,
      spend: 0,
    });
    expect(result.items[0]?.change.advertising.spend).toBeNull();
    expect(result.items[0]?.comparison.derived.contributionAfterAds).toBeNull();
  });

  it('preserves exact mapping detail and same-product variants with a page-local mapping read', async () => {
    const { workspace, mappings } = dependencies();

    const result = await workspace.detail(storeId, productId, { days: 7 }, now);

    expect(mappings.activeMappings).toHaveBeenCalledWith(
      storeId,
      [canonicalAccountId],
      [productId],
    );
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]?.ad).toMatchObject({
      id: adId,
      metaAdId: 'meta-ad-1',
      name: 'Ad 1',
      adSet: { metaAdSetId: 'meta-adset-1' },
    });
    expect(result.mappings[0]?.variants).toHaveLength(2);
  });

  it('rejects a legacy external account that is not selected for the store', async () => {
    const { workspace, unified } = dependencies();

    await expect(
      workspace.list(storeId, { days: 7, page: 1, limit: 50, accountId: 'act_stale' }, now),
    ).rejects.toMatchObject({ code: 'META_AD_ACCOUNT_NOT_SELECTED' });
    expect(unified.list).not.toHaveBeenCalled();
  });

  it('contains no legacy full-universe Product Ads read path', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/modules/analytics/product-ads.workspace.ts'),
      'utf8',
    );
    expect(source).toContain('UnifiedProductAdsService');
    expect(source).not.toContain('getCommerceRows');
    expect(source).not.toContain('getMetaRows');
    expect(source).not.toContain('getVariantCosts');
    expect(source).not.toContain('getActiveMappings');
    expect(source).not.toContain('buildProductAdsPeriod');
  });
});
