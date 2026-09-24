import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { UnifiedProductAdsRepository } from '../../../src/modules/analytics/unified-product-ads.repository.js';
import { UnifiedProductAdsService } from '../../../src/modules/analytics/unified-product-ads.service.js';
import type { IntelligenceStorefrontEvidenceRow } from '../../../src/modules/intelligence/intelligence-storefront.read.repository.js';
import { buildStorefrontBehaviorEvidence } from '../../../src/modules/intelligence/storefront-intelligence.metrics.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const storeIds: string[] = [];
const now = new Date('2026-09-24T12:00:00.000Z');
const currentFrom = new Date('2026-09-01T00:00:00.000Z');
const currentTo = new Date('2026-09-30T23:59:59.999Z');
const comparisonFrom = new Date('2026-08-01T00:00:00.000Z');
const comparisonTo = new Date('2026-08-31T23:59:59.999Z');

function candidateInput(storeId: string, productId?: string) {
  return {
    storeId,
    accountIds: [],
    currency: 'USD',
    currentFrom,
    currentTo,
    comparisonFrom,
    comparisonTo,
    metricCurrentFrom: currentFrom,
    metricCurrentTo: currentTo,
    metricComparisonFrom: comparisonFrom,
    metricComparisonTo: comparisonTo,
    historyComplete: true,
    page: 1,
    limit: 50,
    productId,
  };
}

afterEach(async () => {
  for (const storeId of storeIds.splice(0)) {
    await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
  }
});

describeDatabase('Unified Product × Ads candidate universe without paid media', () => {
  it('keeps Shopify commerce candidates when there is no AdvertisingAccount', async () => {
    const suffix = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${suffix}`,
        name: 'No Ads Commerce',
        myshopifyDomain: `no-ads-commerce-${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    storeIds.push(store.id);
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        shopifyProductId: `gid://shopify/Product/${suffix}`,
        title: 'Commerce candidate',
        status: 'ACTIVE',
      },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: `gid://shopify/Order/${suffix}`,
        name: '#NO-ADS',
        shopifyCreatedAt: new Date('2026-09-20T10:00:00.000Z'),
        processedAt: new Date('2026-09-20T10:00:00.000Z'),
        currencyCode: 'USD',
        currentSubtotalLineItemsQuantity: 1,
        currentTotalAmount: '50',
        currentTotalDiscountsAmount: '0',
      },
    });
    await prisma.orderLineItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        shopifyLineItemId: `gid://shopify/LineItem/${suffix}`,
        shopifyProductId: product.shopifyProductId,
        title: product.title,
        quantity: 1,
        currentQuantity: 1,
        discountedTotal: '50',
      },
    });

    const result = await new UnifiedProductAdsRepository().rankedProductCandidates(
      candidateInput(store.id),
    );

    expect(result).toEqual({ productIds: [product.id], total: 1 });
  });

  it('seeds an explicitly requested valid product even without orders or mappings', async () => {
    const suffix = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${suffix}`,
        name: 'Detail candidate',
        myshopifyDomain: `detail-candidate-${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    storeIds.push(store.id);
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        shopifyProductId: `gid://shopify/Product/${suffix}`,
        title: 'Zero-sales detail target',
        status: 'ACTIVE',
      },
    });

    const result = await new UnifiedProductAdsRepository().rankedProductCandidates(
      candidateInput(store.id, product.id),
    );

    expect(result).toEqual({ productIds: [product.id], total: 1 });
  });

  it('does not seed an explicitly requested product from another store or a nonexistent product', async () => {
    const suffix = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${suffix}-a`,
        name: 'Requested store',
        myshopifyDomain: `requested-${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    const otherStore = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${suffix}-b`,
        name: 'Other store',
        myshopifyDomain: `other-${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    storeIds.push(store.id, otherStore.id);
    const otherProduct = await prisma.product.create({
      data: {
        storeId: otherStore.id,
        shopifyProductId: `gid://shopify/Product/${suffix}-other`,
        title: 'Other store product',
        status: 'ACTIVE',
      },
    });
    const repository = new UnifiedProductAdsRepository();

    await expect(
      repository.rankedProductCandidates(candidateInput(store.id, otherProduct.id)),
    ).resolves.toEqual({ productIds: [], total: 0 });
    await expect(
      repository.rankedProductCandidates(candidateInput(store.id, randomUUID())),
    ).resolves.toEqual({ productIds: [], total: 0 });
  });
});

const productId = '22222222-2222-4222-8222-222222222222';
const partialCommerce = {
  productId,
  period: 'CURRENT' as const,
  orderCount: 2,
  soldUnits: 3,
  refundedUnits: 0,
  productRevenue: 90,
  refunds: 0,
  rawCogs: 30,
  costRelevantUnits: 3,
  costCoveredUnits: 3,
};

function productEvidence(): IntelligenceStorefrontEvidenceRow {
  return {
    period: 'CURRENT',
    dimension: 'PRODUCT',
    dimensionKey: 'gid://shopify/Product/1',
    productId,
    productExternalId: 'gid://shopify/Product/1',
    productTitle: 'No Ads Product',
    landingPageUrl: null,
    sourceRowCount: 1,
    sessionCount: 20,
    productViewSessionCount: 20,
    addToCartSessionCount: 10,
    cartViewSessionCount: 8,
    cartViewCheckoutSessionCount: 6,
    cartViewPurchaseSessionCount: 4,
    checkoutStartSessionCount: 6,
    checkoutStartPurchaseSessionCount: 0,
    checkoutCompletedSessionCount: 0,
    linkedPurchaseSessionCount: 3,
  };
}

function service(input: {
  historyComplete: boolean;
  commerceRows?: unknown[];
  storefrontRows?: IntelligenceStorefrontEvidenceRow[];
}) {
  const scope = {
    resolve: vi.fn().mockResolvedValue({ states: [], allSelectedAccounts: [], accounts: [] }),
  };
  const advertising = { metricRows: vi.fn().mockResolvedValue([]) };
  const repository = {
    mappingAccountingRows: vi.fn().mockResolvedValue([]),
    rankedProductCandidates: vi.fn().mockResolvedValue({ productIds: [productId], total: 1 }),
    activeMappings: vi.fn().mockResolvedValue([]),
    mappingResolutionsForProducts: vi.fn().mockResolvedValue([]),
    adMetricRows: vi.fn().mockResolvedValue([]),
    productIdentities: vi.fn().mockResolvedValue([
      {
        id: productId,
        shopifyProductId: 'gid://shopify/Product/1',
        title: 'No Ads Product',
        status: 'ACTIVE',
        deletedAt: null,
      },
    ]),
  };
  const commerce = {
    getProductEconomicsAggregates: vi.fn().mockResolvedValue(input.commerceRows ?? []),
  };
  const inventory = { getInventoryEvidenceAggregates: vi.fn().mockResolvedValue([]) };
  const storefront = {
    getEvidence: vi.fn().mockResolvedValue(input.storefrontRows ?? []),
  };
  const context = {
    getContext: vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'TRUSTED',
      inventoryReviewedAt: now,
      inventoryRestockLeadTimeDays: 14,
      inventoryLowStockThreshold: 5,
      shopifyConnection: { status: 'ACTIVE', scopes: [], lastSyncedAt: now },
      successfulOrderHistorySync: input.historyComplete
        ? { status: 'SUCCEEDED', recordsRead: 1, recordsWritten: 1, finishedAt: now }
        : null,
      metaConnection: null,
      latestMetaInsightSyncedAt: null,
      pixelInstallation: null,
      storefrontBehaviorRollup: { lastRolledUpAt: null, lastError: null },
    }),
  };
  return new UnifiedProductAdsService(
    scope as never,
    advertising as never,
    repository as never,
    commerce as never,
    inventory as never,
    storefront as never,
    context as never,
  );
}

async function list(serviceUnderTest: UnifiedProductAdsService) {
  return serviceUnderTest.list(
    '11111111-1111-4111-8111-111111111111',
    { provider: 'ALL', days: 30, page: 1, limit: 10 },
    now,
  );
}

describe('Unified Product × Ads no-account truth semantics', () => {
  it('keeps authoritative Shopify commerce while paid-media evidence stays unavailable', async () => {
    const result = await list(service({ historyComplete: true, commerceRows: [partialCommerce] }));
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: true,
      netUnits: 3,
      netProductRevenue: 90,
      contributionBeforeAds: 60,
    });
    expect(item.current.advertising).toMatchObject({
      evidenceAvailable: false,
      spend: null,
      impressions: null,
      clicks: null,
    });
    expect(item.current.intelligence.contributionAfterAds).toBeNull();
    expect(item.mapping.limitations).toContain('NO_SELECTED_ADVERTISING_ACCOUNT');
    expect(result.summary.current).toMatchObject({
      evidenceAvailable: false,
      compatiblePaidSpend: null,
      unmappedSpend: null,
    });
  });

  it('preserves factual zero commerce with complete history and unavailable advertising', async () => {
    const result = await list(service({ historyComplete: true }));
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: true,
      orderCount: 0,
      netUnits: 0,
      netProductRevenue: 0,
    });
    expect(item.current.advertising.evidenceAvailable).toBe(false);
    expect(item.current.advertising.spend).toBeNull();
  });

  it('keeps incomplete Shopify commerce unknown rather than fabricating zero', async () => {
    const result = await list(
      service({ historyComplete: false, commerceRows: [partialCommerce] }),
    );
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: false,
      orderCount: null,
      netUnits: null,
      netProductRevenue: null,
      contributionBeforeAds: null,
    });
    expect(item.current.advertising.spend).toBeNull();
  });

  it('returns detail for an explicitly resolved Shopify product without paid media', async () => {
    const result = await service({ historyComplete: true }).detail(
      '11111111-1111-4111-8111-111111111111',
      productId,
      { provider: 'ALL', days: 30 },
      now,
    );

    expect(result.product.id).toBe(productId);
    expect(result.current.commerce.netProductRevenue).toBe(0);
    expect(result.current.advertising.evidenceAvailable).toBe(false);
  });

  it('does not report 100% product checkout abandonment from unavailable purchase overlap', async () => {
    const result = await list(
      service({ historyComplete: true, storefrontRows: [productEvidence()] }),
    );

    expect(result.items[0]!.current.storefront.metrics?.checkoutStartSessions).toBe(6);
    expect(result.items[0]!.current.storefront.metrics?.checkoutAbandonmentRate).toBeNull();
  });
});

describe('Store-level checkout abandonment truth remains intact', () => {
  it('uses authoritative STORE checkout/purchase overlap', () => {
    const row: IntelligenceStorefrontEvidenceRow = {
      ...productEvidence(),
      dimension: 'STORE',
      dimensionKey: 'STORE',
      productId: null,
      productExternalId: null,
      productTitle: null,
      checkoutStartSessionCount: 10,
      checkoutStartPurchaseSessionCount: 5,
    };

    const evidence = buildStorefrontBehaviorEvidence([row]);
    expect(evidence[0]!.current.checkoutCompletionRate).toBe(0.5);
    expect(evidence[0]!.current.checkoutAbandonmentRate).toBe(0.5);
  });
});
