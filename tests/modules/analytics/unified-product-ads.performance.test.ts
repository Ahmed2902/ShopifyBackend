import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import {
  runWithRequestPerformanceContext,
  type RequestPerformanceContext,
} from '../../../src/observability/request-performance.js';
import { UnifiedAdvertisingRepository } from '../../../src/modules/advertising/unified-advertising.repository.js';
import { CommerceAnalyticsReadRepository } from '../../../src/modules/analytics/commerce-analytics.read.repository.js';
import { UnifiedProductAdsRepository } from '../../../src/modules/analytics/unified-product-ads.repository.js';
import { UnifiedProductAdsService } from '../../../src/modules/analytics/unified-product-ads.service.js';
import { IntelligenceCommerceReadRepository } from '../../../src/modules/intelligence/intelligence-commerce.read.repository.js';
import { IntelligenceStorefrontReadRepository } from '../../../src/modules/intelligence/intelligence-storefront.read.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

function perfContext(): RequestPerformanceContext {
  return {
    requestId: randomUUID(),
    startedAtMs: performance.now(),
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
    spans: {},
    cacheOutcomes: { hit: 0, miss: 0, bypass: 0, error: 0, fresh: 0, coalesced: 0 },
    memoizedReads: new Map(),
  };
}

async function createAccountHierarchy(input: {
  storeId: string;
  provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS';
  suffix: string;
  currency?: string;
  kind?: 'AD_SET' | 'AD_GROUP' | 'ASSET_GROUP';
  targetScope?: 'UNKNOWN' | 'PRODUCT' | 'MULTI_PRODUCT';
  withAd?: boolean;
}) {
  const account = await prisma.advertisingAccount.create({
    data: {
      storeId: input.storeId,
      provider: input.provider,
      providerEntityId: `account-${input.suffix}`,
      name: `${input.provider} ${input.suffix}`,
      currency: input.currency ?? 'USD',
      timezone: 'UTC',
    },
  });
  const campaign = await prisma.advertisingCampaign.create({
    data: {
      accountId: account.id,
      providerEntityId: `campaign-${input.suffix}`,
      name: `Campaign ${input.suffix}`,
    },
  });
  const group = await prisma.advertisingGroup.create({
    data: {
      accountId: account.id,
      campaignId: campaign.id,
      providerEntityId: `group-${input.suffix}`,
      kind: input.kind ?? (input.provider === 'META' ? 'AD_SET' : 'AD_GROUP'),
      name: `Group ${input.suffix}`,
    },
  });
  const ad =
    input.withAd === false
      ? null
      : await prisma.advertisingAd.create({
          data: {
            accountId: account.id,
            campaignId: campaign.id,
            groupId: group.id,
            providerEntityId: `ad-${input.suffix}`,
            name: `Ad ${input.suffix}`,
            targetScope: input.targetScope ?? 'UNKNOWN',
          },
        });
  return { account, campaign, group, ad };
}

async function metric(input: {
  accountId: string;
  campaignId?: string | null;
  groupId?: string | null;
  adId?: string | null;
  level: 'ACCOUNT' | 'AD' | 'ASSET_GROUP';
  date: string;
  currency: string;
  spend: number;
  suffix: string;
}) {
  await prisma.advertisingDailyMetric.create({
    data: {
      metricKey: `perf:${input.suffix}:${input.date}:${input.level}`,
      accountId: input.accountId,
      campaignId: input.campaignId ?? null,
      groupId: input.groupId ?? null,
      adId: input.adId ?? null,
      level: input.level,
      date: new Date(`${input.date}T00:00:00.000Z`),
      currency: input.currency,
      spend: input.spend,
      impressions: 1000n,
      clicks: 100n,
      conversions: null,
      conversionValue: null,
    },
  });
}

async function fixture() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Product Ads performance',
      myshopifyDomain: `product-ads-perf-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);

  const products = Array.from({ length: 10_000 }, (_, index) => ({
    id: randomUUID(),
    storeId: store.id,
    shopifyProductId: `gid://shopify/Product/${suffix}-${index}`,
    title: `Product ${String(index).padStart(5, '0')}`,
    status: 'ACTIVE',
  }));
  for (let offset = 0; offset < products.length; offset += 1000) {
    await prisma.product.createMany({ data: products.slice(offset, offset + 1000) });
  }

  const meta = await createAccountHierarchy({
    storeId: store.id,
    provider: 'META',
    suffix: `${suffix}-meta`,
  });
  const tiktok = await createAccountHierarchy({
    storeId: store.id,
    provider: 'TIKTOK',
    suffix: `${suffix}-tiktok`,
    targetScope: 'MULTI_PRODUCT',
  });
  const google = await createAccountHierarchy({
    storeId: store.id,
    provider: 'GOOGLE_ADS',
    suffix: `${suffix}-google-search`,
    targetScope: 'PRODUCT',
  });
  const pmax = await createAccountHierarchy({
    storeId: store.id,
    provider: 'GOOGLE_ADS',
    suffix: `${suffix}-pmax`,
    kind: 'ASSET_GROUP',
    withAd: false,
  });
  const eur = await createAccountHierarchy({
    storeId: store.id,
    provider: 'META',
    suffix: `${suffix}-eur`,
    currency: 'EUR',
    targetScope: 'PRODUCT',
  });

  await prisma.advertisingProductMapping.createMany({
    data: products.slice(0, 2000).map((product) => ({
      adId: meta.ad!.id,
      productId: product.id,
      source: 'INFERRED',
      confidence: 0.8,
    })),
  });
  await prisma.advertisingProductMapping.createMany({
    data: [products[2000]!, products[2001]!].map((product) => ({
      adId: tiktok.ad!.id,
      productId: product.id,
      source: 'INFERRED',
      confidence: 0.9,
    })),
  });
  await prisma.advertisingProductMapping.create({
    data: {
      adId: google.ad!.id,
      productId: products[9999]!.id,
      source: 'MANUAL',
      confidence: 1,
      isMerchantConfirmed: true,
    },
  });
  await prisma.advertisingProductMapping.create({
    data: {
      adId: eur.ad!.id,
      productId: products[9000]!.id,
      source: 'MANUAL',
      confidence: 1,
      isMerchantConfirmed: true,
    },
  });

  const current = '2026-09-23';
  const comparison = '2026-08-24';
  for (const [date, metaSpend, tiktokSpend, googleAdSpend, googleTotal, pmaxSpend] of [
    [current, 25, 50, 100, 300, 200],
    [comparison, 20, 40, 80, 240, 160],
  ] as const) {
    await metric({
      accountId: meta.account.id,
      campaignId: meta.campaign.id,
      groupId: meta.group.id,
      adId: meta.ad!.id,
      level: 'AD',
      date,
      currency: 'USD',
      spend: metaSpend,
      suffix: `${suffix}-meta`,
    });
    await metric({
      accountId: tiktok.account.id,
      campaignId: tiktok.campaign.id,
      groupId: tiktok.group.id,
      adId: tiktok.ad!.id,
      level: 'AD',
      date,
      currency: 'USD',
      spend: tiktokSpend,
      suffix: `${suffix}-tiktok`,
    });
    await metric({
      accountId: google.account.id,
      campaignId: google.campaign.id,
      groupId: google.group.id,
      adId: google.ad!.id,
      level: 'AD',
      date,
      currency: 'USD',
      spend: googleAdSpend,
      suffix: `${suffix}-google-ad`,
    });
    await metric({
      accountId: google.account.id,
      level: 'ACCOUNT',
      date,
      currency: 'USD',
      spend: googleTotal,
      suffix: `${suffix}-google-account`,
    });
    await metric({
      accountId: pmax.account.id,
      campaignId: pmax.campaign.id,
      groupId: pmax.group.id,
      level: 'ASSET_GROUP',
      date,
      currency: 'USD',
      spend: pmaxSpend,
      suffix: `${suffix}-pmax`,
    });
    await metric({
      accountId: eur.account.id,
      campaignId: eur.campaign.id,
      groupId: eur.group.id,
      adId: eur.ad!.id,
      level: 'AD',
      date,
      currency: 'EUR',
      spend: 9999,
      suffix: `${suffix}-eur`,
    });
  }

  const accounts = [meta.account, tiktok.account, google.account, pmax.account, eur.account].map(
    (account) => ({
      id: account.id,
      provider: account.provider as 'META' | 'TIKTOK' | 'GOOGLE_ADS',
      providerEntityId: account.providerEntityId,
      name: account.name,
      status: account.status,
      currency: account.currency,
      timezone: account.timezone,
      lastSyncedAt: account.lastSyncedAt,
    }),
  );
  return {
    store,
    products,
    accounts,
    exactProductId: products[9999]!.id,
    sharedProductId: products[2000]!.id,
  };
}

describeDatabase('Unified Product × Ads scale path', () => {
  let data: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    data = await fixture();
  });

  afterAll(async () => {
    for (const storeId of stores.splice(0)) {
      await prisma.advertisingAccount.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.store.delete({ where: { id: storeId } });
    }
  });

  it('keeps full-scope accounting exact while enriching only the requested page', async () => {
    const repository = new UnifiedProductAdsRepository();
    const commerce = new CommerceAnalyticsReadRepository();
    const inventory = new IntelligenceCommerceReadRepository();
    const storefront = new IntelligenceStorefrontReadRepository();
    const activeMappings = vi.spyOn(repository, 'activeMappings');
    const commerceRows = vi.spyOn(commerce, 'getProductEconomicsAggregates');
    const inventoryRows = vi.spyOn(inventory, 'getInventoryEvidenceAggregates');
    const storefrontRows = vi.spyOn(storefront, 'getEvidence');
    const scope = {
      resolve: vi
        .fn()
        .mockResolvedValue({ accounts: data.accounts, allSelectedAccounts: data.accounts, states: [] }),
    };
    const context = {
      getContext: vi.fn().mockResolvedValue({
        id: data.store.id,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
        inventoryIntelligenceMode: 'TRUSTED',
        inventoryReviewedAt: new Date(),
        inventoryRestockLeadTimeDays: 14,
        inventoryLowStockThreshold: 5,
        shopifyConnection: { status: 'ACTIVE', scopes: [], lastSyncedAt: new Date() },
        successfulOrderHistorySync: {
          status: 'SUCCEEDED',
          recordsRead: 0,
          recordsWritten: 0,
          finishedAt: new Date(),
        },
        metaConnection: null,
        latestMetaInsightSyncedAt: null,
        pixelInstallation: null,
        storefrontBehaviorRollup: { lastRolledUpAt: null, lastError: null },
      }),
    };
    const service = new UnifiedProductAdsService(
      scope as never,
      new UnifiedAdvertisingRepository(),
      repository,
      commerce,
      inventory,
      storefront,
      context as never,
    );

    const request = perfContext();
    const result = await runWithRequestPerformanceContext(request, () =>
      service.list(
        data.store.id,
        { provider: 'ALL', days: 30, page: 1, limit: 50 },
        new Date('2026-09-24T12:00:00.000Z'),
      ),
    );

    expect(result.items).toHaveLength(50);
    expect(result.pagination.total).toBe(2004);
    expect(result.items[0]?.product.id).toBe(data.exactProductId);
    expect(result.summary.current).toMatchObject({
      evidenceAvailable: false,
      compatiblePaidSpend: null,
      exactMappedSpend: 100,
      sharedSpend: 50,
      ambiguousObservedSpend: 25,
      unmappedSpend: null,
    });
    expect(result.summary.current.missingAccountIds).toHaveLength(1);
    expect(result.summary.current.exactMappedSpendByProvider).toEqual([
      { provider: 'GOOGLE_ADS', spend: 100 },
    ]);

    const enrichedIds = activeMappings.mock.calls[0]?.[2] ?? [];
    expect(enrichedIds).toHaveLength(50);
    expect(commerceRows.mock.calls[0]?.[0].productIds).toEqual(enrichedIds);
    expect(inventoryRows.mock.calls[0]?.[1]).toEqual(enrichedIds);
    expect(storefrontRows.mock.calls[0]?.[0].productIds).toEqual(enrichedIds);
    expect(request.queryCount).toBeLessThan(30);

    const laterContext = perfContext();
    const later = await runWithRequestPerformanceContext(laterContext, () =>
      service.list(
        data.store.id,
        { provider: 'ALL', days: 30, page: 20, limit: 50 },
        new Date('2026-09-24T12:00:00.000Z'),
      ),
    );
    expect(later.items).toHaveLength(50);
    expect(later.pagination.total).toBe(2004);
    expect(laterContext.queryCount).toBeLessThanOrEqual(request.queryCount + 2);

    const shared = await service.detail(
      data.store.id,
      data.sharedProductId,
      { provider: 'ALL', days: 30 },
      new Date('2026-09-24T12:00:00.000Z'),
    );
    expect(shared.mapping.limitations).toContain('SHARED_MAPPING_SPEND_UNALLOCATED');
    expect(shared.current.advertising.spend).toBeNull();
    expect(shared.current.intelligence.contributionAfterAds).toBeNull();
  }, 15_000);

  it.each([30, 90, 365])(
    'keeps candidate selection to one DB operation for %d-day windows',
    async (days) => {
      const repository = new UnifiedProductAdsRepository();
      const currentTo = new Date('2026-09-23T00:00:00.000Z');
      const currentFrom = new Date(currentTo.getTime() - (days - 1) * 86_400_000);
      const comparisonTo = new Date(currentFrom.getTime() - 86_400_000);
      const comparisonFrom = new Date(comparisonTo.getTime() - (days - 1) * 86_400_000);
      const context = perfContext();
      const result = await runWithRequestPerformanceContext(context, () =>
        repository.rankedProductCandidates({
          storeId: data.store.id,
          accountIds: data.accounts.map((account) => account.id),
          currency: 'USD',
          currentFrom,
          currentTo: new Date('2026-09-23T23:59:59.999Z'),
          comparisonFrom,
          comparisonTo: new Date(comparisonTo.getTime() + 86_399_999),
          metricCurrentFrom: currentFrom,
          metricCurrentTo: currentTo,
          metricComparisonFrom: comparisonFrom,
          metricComparisonTo: comparisonTo,
          historyComplete: true,
          page: 20,
          limit: 50,
        }),
      );
      expect(result.total).toBe(2004);
      expect(result.productIds).toHaveLength(50);
      expect(context.queryCount).toBeLessThanOrEqual(2);
    },
  );
});