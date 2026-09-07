import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceSnapshotReadService } from '../../../src/modules/intelligence/intelligence-snapshot.read.service.js';
import type { AnalyticsWorkspace } from '../../../src/modules/analytics/analytics.workspace.js';
import type { DashboardReadRepository } from '../../../src/modules/analytics/dashboard.read.repository.js';
import { DashboardWorkspace } from '../../../src/modules/analytics/dashboard.workspace.js';
import type { PerformanceAnalyticsWorkspace } from '../../../src/modules/analytics/performance-analytics.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-07T12:00:00.000Z');

function buildAnalytics(overrides: Partial<AnalyticsWorkspace> = {}) {
  return {
    overview: vi.fn().mockResolvedValue({ marker: 'overview' }),
    ...overrides,
  } as unknown as AnalyticsWorkspace;
}

function buildIntelligence(overrides: Partial<IntelligenceSnapshotReadService> = {}) {
  return {
    read: vi.fn().mockResolvedValue({
      evaluatedAt: now,
      recommendations: [],
    }),
    invalidate: vi.fn(),
    ...overrides,
  } as unknown as IntelligenceSnapshotReadService;
}

function buildRead(overrides: Partial<DashboardReadRepository> = {}) {
  return {
    getInventoryPreview: vi.fn().mockResolvedValue({ inventoryMode: 'DISABLED', items: [] }),
    getRecentOrders: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DashboardReadRepository;
}

function buildPerformance(overrides: Partial<PerformanceAnalyticsWorkspace> = {}) {
  return {
    daily: vi.fn().mockResolvedValue({ marker: 'performance' }),
    ...overrides,
  } as unknown as PerformanceAnalyticsWorkspace;
}

describe('DashboardWorkspace', () => {
  it('keeps the primary overview available when every secondary section fails', async () => {
    const intelligence = buildIntelligence({
      read: vi.fn().mockRejectedValue(new Error('intelligence unavailable')),
    });
    const read = buildRead({
      getInventoryPreview: vi.fn().mockRejectedValue(new Error('inventory unavailable')),
      getRecentOrders: vi.fn().mockRejectedValue(new Error('orders unavailable')),
    });
    const performance = buildPerformance({
      daily: vi.fn().mockRejectedValue(new Error('performance unavailable')),
    });

    const result = await new DashboardWorkspace(
      buildAnalytics(),
      intelligence,
      read,
      performance,
    ).read(storeId, { days: 30 }, now);

    expect(result.overview).toEqual({ marker: 'overview' });
    expect(result.sections).toEqual({
      inventory: { available: false, data: null },
      intelligence: { available: false, data: null },
      recentOrders: { available: false, data: null },
      performance: { available: false, data: null },
    });
  });

  it('uses compact dashboard reads, includes the trend, and propagates explicit freshness', async () => {
    const recommendations = Array.from({ length: 5 }, (_, index) => ({
      ruleId: `rule-${index}`,
      severity: index < 2 ? 'HIGH' : 'LOW',
      title: `Recommendation ${index}`,
    }));
    const intelligence = buildIntelligence({
      read: vi.fn().mockResolvedValue({
        evaluatedAt: now,
        recommendations,
      } as never),
    });
    const read = buildRead({
      getInventoryPreview: vi.fn().mockResolvedValue({
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
      }),
    });
    const performance = buildPerformance();

    const result = await new DashboardWorkspace(
      buildAnalytics(),
      intelligence,
      read,
      performance,
    ).read(storeId, { days: 30 }, now, { fresh: true });

    expect(read.getInventoryPreview).toHaveBeenCalledWith({
      storeId,
      days: 30,
      from: undefined,
      to: undefined,
      now,
      limit: 8,
    });
    expect(intelligence.read).toHaveBeenCalledWith(storeId, { fresh: true });
    expect(performance.daily).toHaveBeenCalledWith(storeId, { days: 30 }, now);
    expect(result.sections.inventory).toMatchObject({
      available: true,
      data: { inventoryMode: 'TRUSTED' },
    });
    expect(result.sections.intelligence).toMatchObject({
      available: true,
      data: {
        recommendations: recommendations.slice(0, 4),
        highPriorityCount: 2,
      },
    });
    expect(result.sections.performance).toEqual({
      available: true,
      data: { marker: 'performance' },
    });
  });
});
