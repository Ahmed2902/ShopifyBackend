import { describe, expect, it, vi } from 'vitest';
import { UnifiedProductAdsService } from '../../../src/modules/analytics/unified-product-ads.service.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-24T12:00:00.000Z');

const partialRow = {
  productId,
  period: 'CURRENT' as const,
  orderCount: 2,
  soldUnits: 30,
  refundedUnits: 0,
  productRevenue: 900,
  refunds: 0,
  rawCogs: 300,
  costRelevantUnits: 30,
  costCoveredUnits: 30,
};

function createService(input: {
  historyComplete: boolean;
  commerceRows?: unknown[];
  available?: number;
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
        title: 'Authority Test Product',
        status: 'ACTIVE',
        deletedAt: null,
      },
    ]),
  };
  const commerce = {
    getProductEconomicsAggregates: vi.fn().mockResolvedValue(input.commerceRows ?? []),
  };
  const inventory = {
    getInventoryEvidenceAggregates: vi.fn().mockResolvedValue([
      { productId, available: input.available ?? 100 },
    ]),
  };
  const storefront = { getEvidence: vi.fn().mockResolvedValue([]) };
  const context = {
    getContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'TRUSTED',
      inventoryReviewedAt: new Date('2026-09-24T10:00:00.000Z'),
      inventoryRestockLeadTimeDays: 14,
      inventoryLowStockThreshold: 5,
      shopifyConnection: { status: 'ACTIVE', scopes: [], lastSyncedAt: now },
      successfulOrderHistorySync: input.historyComplete
        ? {
            status: 'SUCCEEDED',
            recordsRead: 10,
            recordsWritten: 10,
            finishedAt: now,
          }
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

async function read(service: UnifiedProductAdsService) {
  return service.list(
    storeId,
    { provider: 'ALL', days: 30, page: 1, limit: 10 },
    now,
  );
}

describe('Unified Product × Ads commerce authority', () => {
  it('A. hides a partial current aggregate row when Shopify history is incomplete', async () => {
    const result = await read(
      createService({ historyComplete: false, commerceRows: [partialRow] }),
    );
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: false,
      orderCount: null,
      netUnits: null,
      netProductRevenue: null,
      contributionBeforeAds: null,
    });
    expect(item.current.inventory.unitsPerDay).toBeNull();
    expect(item.current.inventory.state).not.toBe('OVERSTOCK_WEAK_DEMAND');
    expect(item.current.intelligence.limitations).toContain('INCOMPLETE_COMMERCE_HISTORY');
  });

  it('B. keeps missing aggregate evidence unknown when Shopify history is incomplete', async () => {
    const result = await read(createService({ historyComplete: false }));
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: false,
      orderCount: null,
      netUnits: null,
      netProductRevenue: null,
      contributionBeforeAds: null,
    });
    expect(item.current.inventory.unitsPerDay).toBeNull();
  });

  it('C. preserves factual zero sales when Shopify history is complete', async () => {
    const result = await read(createService({ historyComplete: true }));
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: true,
      orderCount: 0,
      netUnits: 0,
      netProductRevenue: 0,
    });
    expect(item.current.inventory.unitsPerDay).toBe(0);
    expect(item.current.inventory.state).toBe('OVERSTOCK_WEAK_DEMAND');
  });

  it('D. preserves normal current-period commerce when Shopify history is complete', async () => {
    const result = await read(
      createService({ historyComplete: true, commerceRows: [partialRow] }),
    );
    const item = result.items[0]!;

    expect(item.current.commerce).toMatchObject({
      evidenceAvailable: true,
      orderCount: 2,
      netUnits: 30,
      netProductRevenue: 900,
      cogs: 300,
      contributionBeforeAds: 600,
    });
    expect(item.current.inventory.unitsPerDay).toBe(1);
    expect(item.current.inventory.state).toBe('HEALTHY');
  });

  it('E. never turns unknown sales velocity plus high inventory into weak demand', async () => {
    const result = await read(
      createService({ historyComplete: false, commerceRows: [partialRow], available: 500 }),
    );
    const item = result.items[0]!;

    expect(item.current.inventory.unitsPerDay).toBeNull();
    expect(item.current.inventory.state).not.toBe('OVERSTOCK_WEAK_DEMAND');
  });
});
