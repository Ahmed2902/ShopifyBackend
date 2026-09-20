import { describe, expect, it } from 'vitest';
import {
  getPrismaQueryWallTimeMs,
  measureRequestPerformanceSpan,
  recordCacheOutcome,
  recordPrismaQuery,
  recordRequestPerformanceSpan,
  runWithRequestPerformanceContext,
  type RequestPerformanceContext,
} from '../../src/observability/request-performance.js';

function context(): RequestPerformanceContext {
  return {
    requestId: 'request-1',
    startedAtMs: 0,
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
    spans: {},
    cacheOutcomes: { hit: 0, miss: 0, bypass: 0, error: 0, fresh: 0 },
  };
}

describe('request performance context', () => {
  it('records query count, cumulative duration and only the five slowest samples', () => {
    const value = context();

    runWithRequestPerformanceContext(value, () => {
      for (let index = 1; index <= 7; index += 1) {
        recordPrismaQuery({
          model: 'Order',
          operation: 'findMany',
          durationMs: index,
          startedAtMs: index * 10,
          endedAtMs: index * 10 + index,
        });
      }
    });

    expect(value.queryCount).toBe(7);
    expect(value.queryDurationMs).toBe(28);
    expect(value.slowestQueries).toHaveLength(5);
    expect(value.slowestQueries.map((sample) => sample.durationMs)).toEqual([7, 6, 5, 4, 3]);
  });

  it('records named spans and cache outcomes inside the request context', () => {
    const value = context();

    runWithRequestPerformanceContext(value, () => {
      recordRequestPerformanceSpan('redis.http', 12.5);
      recordRequestPerformanceSpan('redis.http', 7.5);
      recordCacheOutcome('hit');
      recordCacheOutcome('miss');
      recordCacheOutcome('hit');
    });

    expect(value.spans['redis.http']).toEqual({ count: 2, durationMs: 20 });
    expect(value.cacheOutcomes).toMatchObject({ hit: 2, miss: 1 });
  });

  it('measures async provider work and records the span even when it fails', async () => {
    const value = context();

    await runWithRequestPerformanceContext(value, async () => {
      await expect(
        measureRequestPerformanceSpan('shopify.admin_api.http', async () => 'ok'),
      ).resolves.toBe('ok');
      await expect(
        measureRequestPerformanceSpan('meta.graph_api.http', async () => {
          throw new Error('provider failed');
        }),
      ).rejects.toThrow('provider failed');
    });

    expect(value.spans['shopify.admin_api.http']?.count).toBe(1);
    expect(value.spans['shopify.admin_api.http']?.durationMs).toBeGreaterThanOrEqual(0);
    expect(value.spans['meta.graph_api.http']?.count).toBe(1);
    expect(value.spans['meta.graph_api.http']?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses union wall time so overlapping parallel queries are not double counted', () => {
    const value = context();
    value.queryIntervals.push(
      { startedAtMs: 0, endedAtMs: 30 },
      { startedAtMs: 10, endedAtMs: 20 },
      { startedAtMs: 25, endedAtMs: 45 },
      { startedAtMs: 60, endedAtMs: 70 },
    );

    expect(getPrismaQueryWallTimeMs(value)).toBe(55);
  });

  it('does not record Prisma work that happens outside an HTTP request context', () => {
    const value = context();

    recordPrismaQuery({
      model: 'Order',
      operation: 'findMany',
      durationMs: 10,
      startedAtMs: 0,
      endedAtMs: 10,
    });
    recordRequestPerformanceSpan('redis.http', 10);
    recordCacheOutcome('hit');

    expect(value.queryCount).toBe(0);
    expect(value.spans).toEqual({});
    expect(value.cacheOutcomes.hit).toBe(0);
  });
});
