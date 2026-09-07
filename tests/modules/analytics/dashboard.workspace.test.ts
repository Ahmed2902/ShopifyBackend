import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceService } from '../../../src/modules/intelligence/intelligence.service.js';
import type { AnalyticsWorkspace } from '../../../src/modules/analytics/analytics.workspace.js';
import type { DashboardReadRepository } from '../../../src/modules/analytics/dashboard.read.repository.js';
import { DashboardWorkspace } from '../../../src/modules/analytics/dashboard.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-07T12:00:00.000Z');

function buildAnalytics(overrides: Partial<AnalyticsWorkspace> = {}) {
  return {
    overview: vi.fn().mockResolvedValue({ marker: 'overview' }),
    inventory: vi.fn().mockResolvedValue({ inventoryMode: 'DISABLED', items: [] }),
    ...overrides,
  } as unknown as AnalyticsWorkspace;
}

function buildIntelligence(overrides: Partial<IntelligenceService> = {}) {
  return {
    snapshot: vi.fn().mockResolvedValue({
      evaluatedAt: now,
      recommendations: [],
    }),
    ...overrides,
  } as unknown as IntelligenceService;
}

function buildRead(overrides: Partial<DashboardReadRepository> = {}) {
  return {
    getRecentOrders: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DashboardReadRepository;
}

describe('DashboardWorkspace', () => {
  it('keeps the primary overview available when every secondary section fails', async () => {
    const analytics = buildAnalytics({
      inventory: vi.fn().mockRejectedValue(new Error('inventory unavailable')),
    });
    const intelligence = buildIntelligence({
      snapshot: vi.fn().mockRejectedValue(new Error('intelligence unavailable')),
    });
    const read = buildRead({
      getRecentOrders: vi.fn().mockRejectedValue(new Error('orders unavailable')),
    });

    const result = await new DashboardWorkspace(analytics, intelligence, read).read(
      storeId,
      { days: 30 },
      now,
    );

    expect(result.overview).toEqual({ marker: 'overview' });
    expect(result.sections).toEqual({
      inventory: { available: false, data: null },
      intelligence: { available: false, data: null },
      recentOrders: { available: false, data: null },
    });
  });

  it('returns only the inventory and intelligence fields rendered by Overview', async () => {
    const analytics = buildAnalytics({
      inventory: vi.fn().mockResolvedValue({
        inventoryMode: 'TRUSTED',
        pagination: { page: 1, limit: 8, total: 1, totalPages: 1 },
        window: {},
        items: [
          {
            inventoryItemId: 'inventory-1',
            product: {
              id: 'product-1',
              shopifyProductId: 'gid://shopify/Product/1',
              title: 'Core Tee',
              status: 'ACTIVE',
              vendor: 'Vendor that Overview does not need',
            },
            variant: {
              id: 'variant-1',
              shopifyVariantId: 'gid://shopify/ProductVariant/1',
              title: 'Medium',
              displayName: 'Core Tee - Medium',
              sku: 'TEE-M',
            },
            tracked: true,
            available: 12,
            incoming: 3,
            committed: 2,
            onHand: 14,
            unitsSoldInWindow: 30,
            unitsPerDay: 1,
            daysCover: 12,
            locations: [{ available: 12, incoming: 3 }],
          },
        ],
      } as never),
    });
    const recommendations = Array.from({ length: 5 }, (_, index) => ({
      ruleId: `rule-${index}`,
      severity: index < 2 ? 'HIGH' : 'LOW',
      title: `Recommendation ${index}`,
    }));
    const intelligence = buildIntelligence({
      snapshot: vi.fn().mockResolvedValue({
        evaluatedAt: now,
        recommendations,
      } as never),
    });

    const result = await new DashboardWorkspace(analytics, intelligence, buildRead()).read(
      storeId,
      { days: 30 },
      now,
    );

    expect(result.sections.inventory).toEqual({
      available: true,
      data: {
        inventoryMode: 'TRUSTED',
        items: [
          {
            inventoryItemId: 'inventory-1',
            product: { id: 'product-1', title: 'Core Tee' },
            variant: { id: 'variant-1', title: 'Medium', displayName: 'Core Tee - Medium' },
            available: 12,
            incoming: 3,
            unitsSoldInWindow: 30,
            unitsPerDay: 1,
            daysCover: 12,
          },
        ],
      },
    });
    expect(result.sections.intelligence).toMatchObject({
      available: true,
      data: {
        recommendations: recommendations.slice(0, 4),
        highPriorityCount: 2,
      },
    });
  });
});
