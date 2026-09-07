import { describe, expect, it } from 'vitest';
import {
  getPrismaQueryWallTimeMs,
  recordPrismaQuery,
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

    expect(value.queryCount).toBe(0);
  });
});
