import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { CommerceAnalyticsReadRepository } from '../../../src/modules/analytics/commerce-analytics.read.repository.js';
import type { ProductLeaderboardReadRepository } from '../../../src/modules/analytics/product-leaderboard.read.repository.js';
import { ProductLeaderboardService } from '../../../src/modules/analytics/product-leaderboard.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const productC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deletedProduct = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function analyticsRepository() {
  return {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: null,
      metaConnection: null,
    }),
  } as unknown as AnalyticsRepository;
}

function commerceRepository() {
  return {
    getProductEconomicsAggregates: vi.fn().mockResolvedValue([
      {
        period: 'CURRENT',
        productId: productA,
        orderCount: 2,
        soldUnits: 4,
        refundedUnits: 1,
        productRevenue: 120,
        refunds: 20,
        rawCogs: 40,
        costCoveredUnits: 3,
        costRelevantUnits: 3,
      },
      {
        period: 'CURRENT',
        productId: productB,
        orderCount: 3,
        soldUnits: 5,
        refundedUnits: 0,
        productRevenue: 300,
        refunds: 0,
        rawCogs: 100,
        costCoveredUnits: 5,
        costRelevantUnits: 5,
      },
      {
        period: 'COMPARISON',
        productId: productA,
        orderCount: 4,
        soldUnits: 8,
        refundedUnits: 0,
        productRevenue: 200,
        refunds: 0,
        rawCogs: 80,
        costCoveredUnits: 8,
        costRelevantUnits: 8,
      },
      {
        period: 'COMPARISON',
        productId: productB,
        orderCount: 1,
        soldUnits: 2,
        refundedUnits: 0,
        productRevenue: 100,
        refunds: 0,
        rawCogs: 40,
        costCoveredUnits: 2,
        costRelevantUnits: 2,
      },
      {
        period: 'COMPARISON',
        productId: productC,
        orderCount: 5,
        soldUnits: 10,
        refundedUnits: 0,
        productRevenue: 500,
        refunds: 0,
        rawCogs: 200,
        costCoveredUnits: 10,
        costRelevantUnits: 10,
      },
      {
        period: 'CURRENT',
        productId: deletedProduct,
        orderCount: 99,
        soldUnits: 99,
        refundedUnits: 0,
        productRevenue: 9999,
        refunds: 0,
        rawCogs: 1,
        costCoveredUnits: 99,
        costRelevantUnits: 99,
      },
    ]),
  } as unknown as CommerceAnalyticsReadRepository;
}

function productRepository() {
  return {
    getCatalogProductCount: vi.fn().mockResolvedValue(5),
    getProductsByIds: vi.fn().mockResolvedValue([
      {
        id: productA,
        shopifyProductId: 'gid://shopify/Product/A',
        title: 'Alpha',
        handle: 'alpha',
        productType: 'Shirts',
        vendor: 'Stride',
        status: 'ACTIVE',
        tracksInventory: true,
        totalInventory: 20,
      },
      {
        id: productB,
        shopifyProductId: 'gid://shopify/Product/B',
        title: 'Beta',
        handle: 'beta',
        productType: 'Shirts',
        vendor: 'Stride',
        status: 'ACTIVE',
        tracksInventory: true,
        totalInventory: 8,
      },
      {
        id: productC,
        shopifyProductId: 'gid://shopify/Product/C',
        title: 'Comparison only',
        handle: 'comparison-only',
        productType: 'Shirts',
        vendor: 'Stride',
        status: 'ACTIVE',
        tracksInventory: true,
        totalInventory: 4,
      },
    ]),
  } as unknown as ProductLeaderboardReadRepository;
}

describe('ProductLeaderboardService', () => {
  it('ranks store-wide window activity by current net product revenue and excludes deleted catalog products', async () => {
    const analytics = analyticsRepository();
    const commerce = commerceRepository();
    const products = productRepository();
    const service = new ProductLeaderboardService(analytics, commerce, products);

    const result = await service.read(
      storeId,
      { from: '2026-08-20', to: '2026-09-18', days: 30, limit: 2 },
      new Date('2026-09-18T12:00:00.000Z'),
    );

    expect(commerce.getProductEconomicsAggregates).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        currency: 'USD',
      }),
    );
    expect(commerce.getProductEconomicsAggregates).not.toHaveBeenCalledWith(
      expect.objectContaining({ productIds: expect.anything() }),
    );
    expect(products.getProductsByIds).toHaveBeenCalledWith(
      storeId,
      expect.arrayContaining([productA, productB, productC, deletedProduct]),
    );
    expect(result.ranking).toEqual({
      scope: 'STORE_WIDE_WINDOW_ACTIVITY',
      metric: 'NET_PRODUCT_REVENUE',
      limit: 2,
      windowActiveProducts: 3,
      catalogProducts: 5,
    });
    expect(result.items.map((item) => [item.rank, item.product.id])).toEqual([
      [1, productB],
      [2, productA],
    ]);
    expect(result.totals.current.netProductRevenue).toBe(400);
    expect(result.totals.current.netUnits).toBe(8);
    expect(result.totals.comparison.netProductRevenue).toBe(800);
  });
});
