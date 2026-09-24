import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsWorkspaceCachedReads } from '../../../src/lib/store-decision-cache.js';
import { UnifiedAnalyticsController } from '../../../src/modules/analytics/unified-analytics.controller.js';
import { recommendationLimit } from '../../../src/modules/intelligence/recommendation-entitlement.js';
import { parseScopedUnifiedRecommendationOccurrenceKey } from '../../../src/modules/intelligence/unified-recommendation-occurrence-scope.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const accountId = '44444444-4444-4444-8444-444444444444';

function request(query: Record<string, string> = {}) {
  return {
    context: { storeId },
    query,
    params: {},
  } as unknown as Request;
}

function response(limit: number) {
  const res = {
    locals: { billing: { entitlements: { recommendationLimit: limit } } },
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function result(count: number) {
  return {
    schemaVersion: '2.0',
    generatedAt: new Date('2026-09-24T12:00:00.000Z'),
    truthModel: { commerce: 'SHOPIFY' },
    filters: { provider: 'ALL', accountId: null, currency: null },
    window: {
      current: { from: '2026-08-26', to: '2026-09-24' },
      comparison: { from: '2026-07-27', to: '2026-08-25' },
    },
    recommendations: Array.from({ length: count }, (_, index) => ({
      occurrenceKey: `occurrence-${index}`,
      ruleId: `rule-${index}`,
    })),
    confidenceModel: { type: 'DETERMINISTIC_ENUM' },
    dataQuality: { confidence: 'HIGH', items: [] },
    evaluationBounds: { campaigns: 100, groups: 100, ads: 100, products: 100 },
    limitations: [],
  };
}

function controller(decisions: { read: ReturnType<typeof vi.fn> }) {
  return new UnifiedAnalyticsController(
    {} as never,
    {} as never,
    {} as never,
    decisions as never,
    {} as never,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Unified decisions recommendation entitlement', () => {
  it('caps an over-limit unified decision response while preserving data quality', async () => {
    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(8)) };
    const res = response(3);

    await controller(decisions).decisionList(request(), res);

    const payload = vi.mocked(res.json).mock.calls[0]![0] as ReturnType<typeof result>;
    expect(payload.recommendations).toHaveLength(3);
    expect(payload.dataQuality).toEqual({ confidence: 'HIGH', items: [] });
  });

  it('preserves the established minimum-one entitlement semantics when configured with zero', async () => {
    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(8)) };
    const res = response(0);

    expect(recommendationLimit(res)).toBe(1);
    await controller(decisions).decisionList(request(), res);

    const payload = vi.mocked(res.json).mock.calls[0]![0] as ReturnType<typeof result>;
    expect(payload.recommendations).toHaveLength(1);
  });

  it('allows a larger Pro-style cap without truncating a smaller result', async () => {
    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(8)) };
    const res = response(50);

    await controller(decisions).decisionList(request(), res);

    const payload = vi.mocked(res.json).mock.calls[0]![0] as ReturnType<typeof result>;
    expect(payload.recommendations).toHaveLength(8);
  });

  it('does not allow query parameters to bypass the billing cap', async () => {
    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(20)) };
    const res = response(3);

    await controller(decisions).decisionList(request({ limit: '100', recommendationLimit: '100' }), res);

    const payload = vi.mocked(res.json).mock.calls[0]![0] as ReturnType<typeof result>;
    expect(payload.recommendations).toHaveLength(3);
    expect(decisions.read).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({ provider: 'ALL', days: 30 }),
    );
  });

  it('uses a recommendation-limit-specific cache key so entitlement changes cannot reuse another cap', async () => {
    const run = vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(8)) };
    const instance = controller(decisions);

    await instance.decisionList(request(), response(3));
    await instance.decisionList(request(), response(50));

    expect(String(run.mock.calls[0]![0])).toContain('recommendation-limit-3');
    expect(String(run.mock.calls[1]![0])).toContain('recommendation-limit-50');
  });

  it('carries the exact issued provider/account/currency scope in each unified occurrence handle', async () => {
    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(1)) };
    const res = response(10);

    await controller(decisions).decisionList(
      request({
        provider: 'META',
        accountId,
        currency: 'EUR',
        from: '2026-08-26',
        to: '2026-09-24',
      }),
      res,
    );

    const payload = vi.mocked(res.json).mock.calls[0]![0] as ReturnType<typeof result>;
    const scoped = parseScopedUnifiedRecommendationOccurrenceKey(
      payload.recommendations[0]!.occurrenceKey,
    );
    expect(scoped).toEqual({
      canonicalOccurrenceKey: 'occurrence-0',
      query: {
        provider: 'META',
        accountId,
        currency: 'EUR',
        from: '2026-08-26',
        to: '2026-09-24',
        days: 30,
      },
    });
  });

  it('freezes the resolved dates into a relative-days occurrence handle', async () => {
    vi.spyOn(analyticsWorkspaceCachedReads, 'run').mockImplementation(
      async (_key, loader) => loader(),
    );
    const decisions = { read: vi.fn().mockResolvedValue(result(1)) };
    const res = response(10);

    await controller(decisions).decisionList(
      request({ provider: 'ALL', currency: 'EUR', days: '30' }),
      res,
    );

    const payload = vi.mocked(res.json).mock.calls[0]![0] as ReturnType<typeof result>;
    const scoped = parseScopedUnifiedRecommendationOccurrenceKey(
      payload.recommendations[0]!.occurrenceKey,
    );
    expect(scoped).toEqual({
      canonicalOccurrenceKey: 'occurrence-0',
      query: {
        provider: 'ALL',
        currency: 'EUR',
        from: '2026-08-26',
        to: '2026-09-24',
        days: 30,
      },
    });
  });
});
