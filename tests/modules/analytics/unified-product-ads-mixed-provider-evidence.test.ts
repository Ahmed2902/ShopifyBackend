import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsWorkspaceCachedReads } from '../../../src/lib/store-decision-cache.js';
import { UnifiedAnalyticsController } from '../../../src/modules/analytics/unified-analytics.controller.js';
import { UnifiedProductAdsIntelligenceService } from '../../../src/modules/analytics/unified-product-ads-intelligence.service.js';
import { UnifiedProductAdsService } from '../../../src/modules/analytics/unified-product-ads.service.js';
import { UnifiedDecisionService } from '../../../src/modules/intelligence/unified-decision.service.js';
import { McpToolExecutor } from '../../../src/modules/mcp/mcp-tools.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const metaAccountId = '33333333-3333-4333-8333-333333333333';
const tiktokAccountId = '44444444-4444-4444-8444-444444444444';
const metaAdOne = '55555555-5555-4555-8555-555555555551';
const metaAdTwo = '55555555-5555-4555-8555-555555555552';
const tiktokAd = '66666666-6666-4666-8666-666666666666';
const now = new Date('2026-09-26T12:00:00.000Z');

const metaAccount = {
  id: metaAccountId,
  provider: 'META' as const,
  providerEntityId: 'act_meta',
  name: 'Meta account',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: now,
};

const tiktokAccount = {
  id: tiktokAccountId,
  provider: 'TIKTOK' as const,
  providerEntityId: 'adv_tiktok',
  name: 'TikTok account',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: now,
};

const accounts = [metaAccount, tiktokAccount];

type Mode = 'MIXED' | 'ZERO';

function productIdentity() {
  return {
    id: productId,
    shopifyProductId: 'gid://shopify/Product/1',
    title: 'Evidence product',
    status: 'ACTIVE',
    deletedAt: null,
  };
}

function mapping(adId: string, provider: 'META' | 'TIKTOK', accountId: string, index: number) {
  return {
    id: `77777777-7777-4777-8777-77777777777${index}`,
    adId,
    productId,
    variantId: null,
    granularity: 'PRODUCT',
    source: 'AUTOMATIC',
    confidence: 0.95,
    evidence: { reason: 'fixture' },
    landingUrl: 'https://example.com/products/evidence-product',
    providerProductId: null,
    providerProductGroupId: null,
    merchantConfirmed: false,
    validFrom: new Date('2026-09-01T00:00:00.000Z'),
    validUntil: null,
    ad: {
      id: adId,
      providerEntityId: `external-ad-${index}`,
      name: `Ad ${index}`,
      targetScope: 'SINGLE_PRODUCT',
      targetScopeConfidence: 0.95,
      targetScopeEvidence: { reason: 'fixture' },
      account: {
        id: accountId,
        provider,
        providerEntityId: provider === 'META' ? 'act_meta' : 'adv_tiktok',
        name: provider === 'META' ? 'Meta account' : 'TikTok account',
        currency: 'USD',
      },
      campaign: {
        id: `88888888-8888-4888-8888-88888888888${index}`,
        providerEntityId: `campaign-${index}`,
        name: `Campaign ${index}`,
      },
      group: null,
    },
    product: productIdentity(),
    variant: null,
    collectionMappingCount: 0,
  };
}

const mappings = [
  mapping(metaAdOne, 'META', metaAccountId, 1),
  mapping(metaAdTwo, 'META', metaAccountId, 2),
  mapping(tiktokAd, 'TIKTOK', tiktokAccountId, 3),
];

const resolutions = [
  {
    adId: metaAdOne,
    classification: 'EXACT' as const,
    productId,
    confidence: 0.95,
    merchantConfirmed: false,
  },
  {
    adId: metaAdTwo,
    classification: 'EXACT' as const,
    productId,
    confidence: 0.95,
    merchantConfirmed: false,
  },
  {
    adId: tiktokAd,
    classification: 'EXACT' as const,
    productId,
    confidence: 0.95,
    merchantConfirmed: false,
  },
];

function metricRows(mode: Mode) {
  const current =
    mode === 'ZERO'
      ? [
          {
            period: 'CURRENT' as const,
            adId: metaAdOne,
            accountId: metaAccountId,
            currency: 'USD',
            sourceRows: 1,
            spend: 10,
            impressions: 100,
            clicks: 10,
            conversions: 0,
            conversionValue: 0,
          },
          {
            period: 'CURRENT' as const,
            adId: metaAdTwo,
            accountId: metaAccountId,
            currency: 'USD',
            sourceRows: 1,
            spend: 5,
            impressions: 50,
            clicks: 5,
            conversions: 0,
            conversionValue: 0,
          },
          {
            period: 'CURRENT' as const,
            adId: tiktokAd,
            accountId: tiktokAccountId,
            currency: 'USD',
            sourceRows: 1,
            spend: 7,
            impressions: 70,
            clicks: 7,
            conversions: 0,
            conversionValue: 0,
          },
        ]
      : [
          {
            period: 'CURRENT' as const,
            adId: metaAdOne,
            accountId: metaAccountId,
            currency: 'USD',
            sourceRows: 1,
            spend: 10,
            impressions: 100,
            clicks: 10,
            conversions: 2,
            conversionValue: 20,
          },
          {
            period: 'CURRENT' as const,
            adId: metaAdTwo,
            accountId: metaAccountId,
            currency: 'USD',
            sourceRows: 1,
            spend: 5,
            impressions: 50,
            clicks: 5,
            conversions: null,
            conversionValue: 30,
          },
          {
            period: 'CURRENT' as const,
            adId: tiktokAd,
            accountId: tiktokAccountId,
            currency: 'USD',
            sourceRows: 1,
            spend: 7,
            impressions: 70,
            clicks: 7,
            conversions: 0,
            conversionValue: null,
          },
        ];

  const comparison = [metaAdOne, metaAdTwo].map((adId) => ({
    period: 'COMPARISON' as const,
    adId,
    accountId: metaAccountId,
    currency: 'USD',
    sourceRows: 1,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversionValue: 0,
  }));
  comparison.push({
    period: 'COMPARISON' as const,
    adId: tiktokAd,
    accountId: tiktokAccountId,
    currency: 'USD',
    sourceRows: 1,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversionValue: 0,
  });

  return [...current, ...comparison];
}

function fixture(mode: Mode) {
  const scope = {
    resolve: vi.fn().mockResolvedValue({
      states: [],
      allSelectedAccounts: accounts,
      accounts,
    }),
  };
  const advertising = { metricRows: vi.fn().mockResolvedValue([]) };
  const repository = {
    mappingAccountingRows: vi.fn().mockResolvedValue([]),
    rankedProductCandidates: vi.fn().mockResolvedValue({ productIds: [productId], total: 1 }),
    activeMappings: vi.fn().mockResolvedValue(mappings),
    mappingResolutionsForProducts: vi.fn().mockResolvedValue(resolutions),
    adMetricRows: vi.fn().mockResolvedValue(metricRows(mode)),
    productIdentities: vi.fn().mockResolvedValue([productIdentity()]),
  };
  const commerce = { getProductEconomicsAggregates: vi.fn().mockResolvedValue([]) };
  const inventory = {
    getInventoryEvidenceAggregates: vi.fn().mockResolvedValue([{ productId, available: 0 }]),
  };
  const storefront = { getEvidence: vi.fn().mockResolvedValue([]) };
  const context = {
    getContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'TRUSTED',
      inventoryReviewedAt: now,
      inventoryRestockLeadTimeDays: 14,
      inventoryLowStockThreshold: 5,
      shopifyConnection: { status: 'ACTIVE', scopes: [], lastSyncedAt: now },
      successfulOrderHistorySync: {
        status: 'SUCCEEDED',
        recordsRead: 1,
        recordsWritten: 1,
        finishedAt: now,
      },
      metaConnection: null,
      latestMetaInsightSyncedAt: null,
      pixelInstallation: null,
      storefrontBehaviorRollup: { lastRolledUpAt: null, lastError: null },
    }),
  };

  const base = new UnifiedProductAdsService(
    scope as never,
    advertising as never,
    repository as never,
    commerce as never,
    inventory as never,
    storefront as never,
    context as never,
  );
  const intelligence = new UnifiedProductAdsIntelligenceService(base, scope as never);
  return { base, intelligence, scope };
}

const query = { provider: 'ALL' as const, days: 30, page: 1, limit: 10 };

function assertMixedAdvertising(advertising: {
  providerConversions: number | null;
  providerConversionValue: number | null;
  byProvider: Array<{
    provider: string;
    providerConversions: number | null;
    providerConversionValue: number | null;
  }>;
}) {
  expect(advertising.providerConversions).toBeNull();
  expect(advertising.providerConversionValue).toBeNull();
  expect(advertising.byProvider).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: 'META',
        providerConversions: null,
        providerConversionValue: 50,
      }),
      expect.objectContaining({
        provider: 'TIKTOK',
        providerConversions: 0,
        providerConversionValue: null,
      }),
    ]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Unified Product × Ads mixed provider conversion evidence', () => {
  it('fails closed for mixed-null totals and provider splits while preserving known provider zero', async () => {
    const { base } = fixture('MIXED');
    const payload = await base.list(storeId, query, now);
    const advertising = payload.items[0]!.current.advertising;

    expect(advertising).toMatchObject({
      evidenceAvailable: true,
      spend: 22,
      impressions: 220,
      clicks: 22,
    });
    assertMixedAdvertising(advertising);
  });

  it('preserves genuine all-known zero conversions and conversion value', async () => {
    const { base } = fixture('ZERO');
    const payload = await base.list(storeId, query, now);
    const advertising = payload.items[0]!.current.advertising;

    expect(advertising.providerConversions).toBe(0);
    expect(advertising.providerConversionValue).toBe(0);
    expect(advertising.byProvider).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'META',
          providerConversions: 0,
          providerConversionValue: 0,
        }),
        expect.objectContaining({
          provider: 'TIKTOK',
          providerConversions: 0,
          providerConversionValue: 0,
        }),
      ]),
    );
  });

  it('preserves fail-closed conversions through Product × Ads intelligence and HTTP API', async () => {
    const { intelligence } = fixture('MIXED');
    const intelligentPayload = await intelligence.list(storeId, query, now);
    assertMixedAdvertising(intelligentPayload.items[0]!.current.advertising);

    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const controller = new UnifiedAnalyticsController(
      {} as never,
      intelligence,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = {
      context: { storeId },
      query: { provider: 'ALL', days: '30', page: '1', limit: '10' },
      params: {},
    } as unknown as Request;
    const res = {
      status: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;
    vi.mocked(res.status).mockReturnValue(res);

    await controller.productAdsList(req, res);

    const httpPayload = vi.mocked(res.json).mock.calls[0]![0] as typeof intelligentPayload;
    assertMixedAdvertising(httpPayload.items[0]!.current.advertising);
  });

  it('keeps recommendation provider evidence fail-closed instead of embedding partial provider totals', async () => {
    const { intelligence } = fixture('MIXED');
    const overview = {
      read: vi.fn().mockResolvedValue({
        truthModel: {
          commerce: 'SHOPIFY',
          paidMedia: 'PROVIDER_REPORTED_ATTRIBUTION',
          storefront: 'STRIDE_PIXEL_FIRST_PARTY_OBSERVED',
        },
        filters: { provider: 'ALL', accountId: null, currency: null },
        window: {
          current: { from: '2026-08-28', to: '2026-09-26' },
          comparison: { from: '2026-07-29', to: '2026-08-27' },
        },
        dataQuality: { confidence: 'HIGH', items: [] },
      }),
    };
    const entities = {
      list: vi.fn().mockResolvedValue({ items: [], pagination: { total: 0 } }),
    };
    const lifecycle = {
      attach: vi.fn(async (_requestedStoreId: string, drafts: unknown[]) => drafts),
    };
    const decisionContext = {
      getContext: vi.fn().mockResolvedValue({
        shopifyConnection: { status: 'ACTIVE' },
        successfulOrderHistorySync: { status: 'SUCCEEDED' },
      }),
    };
    const decisions = new UnifiedDecisionService(
      overview as never,
      entities as never,
      intelligence,
      lifecycle as never,
      decisionContext as never,
    );

    const payload = await decisions.read(storeId, { provider: 'ALL', days: 30 }, now);
    const recommendation = payload.recommendations.find(
      (item) => item.ruleId === 'unified_inventory_paid_spend_conflict',
    );

    expect(recommendation).toBeDefined();
    const evidence = recommendation!.evidence as {
      byProvider: Array<{
        provider: string;
        providerConversions: number | null;
        providerConversionValue: number | null;
      }>;
    };
    expect(evidence.byProvider).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'META',
          providerConversions: null,
          providerConversionValue: 50,
        }),
        expect.objectContaining({
          provider: 'TIKTOK',
          providerConversions: 0,
          providerConversionValue: null,
        }),
      ]),
    );
  });

  it('returns the same fail-closed Product × Ads evidence through MCP', async () => {
    const { intelligence } = fixture('MIXED');
    const reads = {
      productAdsList: vi.fn(
        async (
          requestedStoreId: string,
          input: { provider?: 'ALL' | 'META' | 'TIKTOK' | 'GOOGLE_ADS'; days?: number; page?: number; limit?: number },
        ) =>
          intelligence.list(
            requestedStoreId,
            {
              provider: input.provider ?? 'ALL',
              days: input.days ?? 30,
              page: input.page ?? 1,
              limit: input.limit ?? 50,
            },
            now,
          ),
      ),
    };
    const executor = new McpToolExecutor(reads as never, {} as never);

    const payload = (await executor.call(storeId, 'stride_get_product_ads', {
      action: 'list',
      provider: 'ALL',
      days: 30,
      page: 1,
      limit: 10,
    })) as Awaited<ReturnType<UnifiedProductAdsIntelligenceService['list']>>;

    assertMixedAdvertising(payload.items[0]!.current.advertising);
    expect(reads.productAdsList).toHaveBeenCalledTimes(1);
  });
});