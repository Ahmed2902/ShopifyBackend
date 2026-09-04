import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import { AnalyticsWorkspace } from '../../../src/modules/analytics/analytics.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const campaignId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = new Date('2026-09-03T12:00:00.000Z');

function storeContext(inventoryIntelligenceMode = 'DISABLED') {
  return {
    id: storeId,
    currencyCode: 'USD',
    ianaTimezone: 'UTC',
    inventoryIntelligenceMode,
    shopifyConnection: {
      status: 'ACTIVE',
      scopes: ['read_orders', 'read_all_orders'],
      lastSyncedAt: now,
    },
    metaConnection: {
      status: 'ACTIVE',
      selectedAdAccountIds: ['act_101'],
    },
  };
}

function buildRepository(overrides: Partial<AnalyticsRepository> = {}) {
  return {
    getStoreContext: vi.fn().mockResolvedValue(storeContext()),
    getOrders: vi.fn().mockResolvedValue([]),
    getCommerceRows: vi.fn().mockResolvedValue([]),
    getVariantCosts: vi.fn().mockResolvedValue([]),
    getProductsPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getProduct: vi.fn().mockResolvedValue(null),
    getCollectionsPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getInventoryPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getVariantSalesRows: vi.fn().mockResolvedValue([]),
    getMetaRows: vi.fn().mockResolvedValue([]),
    getCampaignsPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getCampaign: vi.fn().mockResolvedValue(null),
    getAdSetsPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getAdSet: vi.fn().mockResolvedValue(null),
    getAdsPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getAd: vi.fn().mockResolvedValue(null),
    getCreativesPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getCreative: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as AnalyticsRepository;
}

describe('AnalyticsWorkspace', () => {
  it('composes Overview without mixing Meta attribution into Shopify commerce truth', async () => {
    const repository = buildRepository({
      getOrders: vi.fn().mockResolvedValue([
        {
          id: 'current-order',
          shopifyCreatedAt: new Date('2026-09-01T10:00:00.000Z'),
          processedAt: new Date('2026-09-01T10:00:00.000Z'),
          currencyCode: 'USD',
          currentSubtotalLineItemsQuantity: 2,
          currentTotalAmount: 120,
          currentTotalDiscountsAmount: 10,
          customerOrderIndex: 1,
          customerJourneyReady: true,
          refunds: [],
        },
        {
          id: 'comparison-order',
          shopifyCreatedAt: new Date('2026-08-25T10:00:00.000Z'),
          processedAt: new Date('2026-08-25T10:00:00.000Z'),
          currencyCode: 'USD',
          currentSubtotalLineItemsQuantity: 1,
          currentTotalAmount: 80,
          currentTotalDiscountsAmount: 0,
          customerOrderIndex: 2,
          customerJourneyReady: true,
          refunds: [],
        },
      ]),
    });
    const workspace = new AnalyticsWorkspace(repository);

    const result = await workspace.overview(storeId, { days: 7 }, now);

    expect(result.commerce.current).toMatchObject({ orders: 1, units: 2, orderValue: 120 });
    expect(result.commerce.comparison).toMatchObject({ orders: 1, units: 1, orderValue: 80 });
    expect(result.commerce.current.newOrders).toBe(1);
    expect(result.commerce.comparison.returningOrders).toBe(1);
    expect(result.advertising).toEqual([]);
    expect(result.blended.current.mer).toBeNull();
    expect(result.profitability.current).toMatchObject({ adSpend: 0, contributionAfterAds: null });
  });

  it('bounds campaign insight reads to the entities on the requested page', async () => {
    const repository = buildRepository({
      getCampaignsPage: vi.fn().mockResolvedValue({
        total: 1,
        items: [
          {
            id: campaignId,
            metaCampaignId: 'campaign-101',
            name: 'Prospecting',
            effectiveStatus: 'ACTIVE',
            configuredStatus: 'ACTIVE',
            objective: 'OUTCOME_SALES',
            buyingType: 'AUCTION',
            bidStrategy: null,
            dailyBudgetMinor: null,
            lifetimeBudgetMinor: null,
            budgetRemainingMinor: null,
            startTime: null,
            stopTime: null,
          },
        ],
      }),
    });
    const workspace = new AnalyticsWorkspace(repository);

    const result = await workspace.campaigns(storeId, { days: 30, page: 1, limit: 50 }, now);

    expect(result.items).toHaveLength(1);
    expect(repository.getMetaRows).toHaveBeenCalledWith(
      storeId,
      ['act_101'],
      expect.any(Date),
      expect.any(Date),
      { campaignIds: [campaignId] },
    );
  });

  it('does not emit deterministic days cover unless inventory is trusted', async () => {
    const inventoryPage = {
      total: 1,
      items: [
        {
          id: 'inventory-item-1',
          tracked: true,
          sku: 'TEE-BLK-M',
          variant: {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            shopifyVariantId: 'gid://shopify/ProductVariant/1',
            title: 'Medium',
            displayName: 'Core Tee - Medium',
            productId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            product: {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              shopifyProductId: 'gid://shopify/Product/1',
              title: 'Core Tee',
            },
          },
          currentLevels: [
            {
              available: 14,
              incoming: 0,
              committed: 2,
              onHand: 16,
              location: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Main' },
            },
          ],
        },
      ],
    };
    const salesRows = [
      {
        variantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        quantity: 14,
        refundLines: [],
      },
    ];
    const disabledRepository = buildRepository({
      getInventoryPage: vi.fn().mockResolvedValue(inventoryPage),
      getVariantSalesRows: vi.fn().mockResolvedValue(salesRows),
    });
    const trustedRepository = buildRepository({
      getStoreContext: vi.fn().mockResolvedValue(storeContext('TRUSTED')),
      getInventoryPage: vi.fn().mockResolvedValue(inventoryPage),
      getVariantSalesRows: vi.fn().mockResolvedValue(salesRows),
    });

    const disabled = await new AnalyticsWorkspace(disabledRepository).inventory(
      storeId,
      { days: 7, page: 1, limit: 50 },
      now,
    );
    const trusted = await new AnalyticsWorkspace(trustedRepository).inventory(
      storeId,
      { days: 7, page: 1, limit: 50 },
      now,
    );

    expect(disabled.items[0]?.daysCover).toBeNull();
    expect(trusted.items[0]?.daysCover).toBe(7);
  });
});
