import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';
import { IntelligenceService } from '../../../src/modules/intelligence/intelligence.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-03T12:00:00.000Z');

function storeContext(shopifyStatus = 'ACTIVE') {
  return {
    id: storeId,
    currencyCode: 'USD',
    ianaTimezone: 'UTC',
    inventoryIntelligenceMode: 'DISABLED',
    inventoryReviewedAt: null,
    shopifyConnection: {
      status: shopifyStatus,
      scopes: ['read_orders', 'read_all_orders'],
      lastSyncedAt: now,
    },
    metaConnection: {
      status: 'ACTIVE',
      selectedAdAccountIds: ['act_101'],
    },
  };
}

function buildRepository(overrides: Partial<IntelligenceRepository> = {}) {
  return {
    getStoreContext: vi.fn().mockResolvedValue(storeContext()),
    getLatestOrderHistorySync: vi.fn().mockResolvedValue({
      status: 'SUCCEEDED',
      recordsRead: 0,
      recordsWritten: 0,
      finishedAt: now,
    }),
    getMetaEvidenceRows: vi.fn().mockResolvedValue([]),
    getCommerceRows: vi.fn().mockResolvedValue([]),
    getActiveProductMappings: vi.fn().mockResolvedValue([]),
    getInventoryLevels: vi.fn().mockResolvedValue([]),
    getVariantCosts: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      inventoryIntelligenceMode: 'DISABLED',
      inventoryReviewedAt: null,
    }),
    updateInventoryMode: vi.fn().mockResolvedValue({
      inventoryIntelligenceMode: 'TRUSTED',
      inventoryReviewedAt: now,
    }),
    ...overrides,
  } as unknown as IntelligenceRepository;
}

describe('IntelligenceService', () => {
  it('computes a read-only snapshot without requiring persisted recommendations', async () => {
    const service = new IntelligenceService(buildRepository());

    const result = await service.snapshot(storeId, now);

    expect(result.recommendations).toEqual([]);
    expect(result.dataQuality).toContainEqual(
      expect.objectContaining({ code: 'META_INSIGHTS_MISSING', status: 'BLOCKED' }),
    );
    expect(result.evidence).toMatchObject({
      campaigns: 0,
      creatives: 0,
      products: 0,
      metaRows: 0,
      commerceRows: 0,
      shopifyCommerceUsable: true,
    });
  });

  it('does not treat missing Shopify evidence as a usable zero-sales baseline', async () => {
    const repository = buildRepository({
      getStoreContext: vi.fn().mockResolvedValue(storeContext('DISCONNECTED')),
      getLatestOrderHistorySync: vi.fn().mockResolvedValue(null),
    });

    const result = await new IntelligenceService(repository).snapshot(storeId, now);

    expect(result.evidence.shopifyCommerceUsable).toBe(false);
    expect(result.dataQuality).toContainEqual(
      expect.objectContaining({ code: 'SHOPIFY_CONNECTION_BLOCKED', status: 'BLOCKED' }),
    );
  });

  it('stores only the inventory trust setting', async () => {
    const repository = buildRepository();
    const service = new IntelligenceService(repository);

    await expect(service.updateInventoryMode(storeId, 'TRUSTED')).resolves.toMatchObject({
      inventoryIntelligenceMode: 'TRUSTED',
    });
    expect(repository.updateInventoryMode).toHaveBeenCalledWith(storeId, 'TRUSTED');
  });
});
