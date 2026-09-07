import { describe, expect, it, vi } from 'vitest';
import { resolveAnalyticsWindows } from '../../../src/modules/analytics/analytics.dates.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { CommerceAnalyticsReadRepository } from '../../../src/modules/analytics/commerce-analytics.read.repository.js';
import { CommerceAnalyticsService } from '../../../src/modules/analytics/commerce-analytics.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function repository() {
  return {
    getProductsPage: vi.fn().mockResolvedValue({
      total: 1,
      items: [
        {
          id: productId,
          shopifyProductId: 'gid://shopify/Product/1',
          title: 'Core Tee',
          handle: 'core-tee',
          status: 'ACTIVE',
          vendor: 'Stride',
          productType: 'Apparel',
          tracksInventory: true,
          totalInventory: 10,
          imageUrl: null,
        },
      ],
    }),
    getCommerceRows: vi.fn().mockRejectedValue(new Error('legacy row materialization must not run')),
    getVariantCosts: vi.fn().mockRejectedValue(new Error('legacy cost history must not run')),
  } as unknown as AnalyticsRepository;
}

function readRepository() {
  return {
    getProductEconomicsAggregates: vi.fn().mockResolvedValue([
      {
        period: 'CURRENT',
        productId,
        orderCount: 2,
        soldUnits: 3,
        refundedUnits: 1,
        productRevenue: 120,
        refunds: 20,
        rawCogs: 30,
        costCoveredUnits: 2,
        costRelevantUnits: 2,
      },
    ]),
  } as unknown as CommerceAnalyticsReadRepository;
}

describe('CommerceAnalyticsService product list performance', () => {
  it('aggregates only the current page in SQL and never materializes commerce/cost histories', async () => {
    const legacy = repository();
    const compact = readRepository();
    const service = new CommerceAnalyticsService(legacy, compact);
    const windows = resolveAnalyticsWindows(
      { from: '2026-08-08', to: '2026-09-06', days: 30 },
      'UTC',
    );
    const store = {
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: null,
      metaConnection: null,
    } as never;

    const result = await service.products(store, windows, 1, 50);

    expect(compact.getProductEconomicsAggregates).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        currency: 'USD',
        productIds: [productId],
      }),
    );
    expect(legacy.getCommerceRows).not.toHaveBeenCalled();
    expect(legacy.getVariantCosts).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      product: { id: productId, title: 'Core Tee' },
      current: {
        orderCount: 2,
        soldUnits: 3,
        refundedUnits: 1,
        netUnits: 2,
        netProductRevenue: 100,
        cogs: 30,
        contributionBeforeAds: 70,
      },
    });
  });
});
