import { describe, expect, it } from 'vitest';
import { resolvePerformanceBudget } from '../../src/observability/performance-budget.js';

describe('performance budgets', () => {
  it('assigns strict cold-path ceilings to the primary analytical surfaces', () => {
    expect(
      resolvePerformanceBudget(
        'GET',
        '/v1/stores/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/analytics/dashboard?days=30',
      ),
    ).toEqual({ name: 'analytics.dashboard', maxDurationMs: 1200, maxPrismaQueries: 12 });

    expect(
      resolvePerformanceBudget(
        'GET',
        '/v1/stores/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/intelligence/snapshot',
      ),
    ).toEqual({ name: 'intelligence.snapshot', maxDurationMs: 1500, maxPrismaQueries: 12 });

    expect(
      resolvePerformanceBudget(
        'GET',
        '/v1/stores/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/analytics/campaigns?page=1&limit=50',
      ),
    ).toEqual({ name: 'analytics.list', maxDurationMs: 700, maxPrismaQueries: 6 });
  });

  it('does not apply analytical GET budgets to mutation routes', () => {
    expect(
      resolvePerformanceBudget(
        'POST',
        '/v1/stores/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/integrations/shopify/sync',
      ),
    ).toBeNull();
  });
});
