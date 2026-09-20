import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export interface PrismaQuerySample {
  model: string | null;
  operation: string;
  durationMs: number;
}

interface PrismaQueryInterval {
  startedAtMs: number;
  endedAtMs: number;
}

export type CacheOutcome = 'hit' | 'miss' | 'bypass' | 'error' | 'fresh' | 'coalesced';

export interface RequestPerformanceSpan {
  count: number;
  durationMs: number;
}

export interface RequestPerformanceContext {
  requestId: string;
  startedAtMs: number;
  queryCount: number;
  queryDurationMs: number;
  queryIntervals: PrismaQueryInterval[];
  slowestQueries: PrismaQuerySample[];
  spans: Record<string, RequestPerformanceSpan>;
  cacheOutcomes: Record<CacheOutcome, number>;
  memoizedReads: Map<string, Promise<unknown>>;
}

type RecordedPrismaQuery = PrismaQuerySample & PrismaQueryInterval;

const requestStorage = new AsyncLocalStorage<RequestPerformanceContext>();
const MAX_SLOW_QUERY_SAMPLES = 5;

export function runWithRequestPerformanceContext<T>(
  context: RequestPerformanceContext,
  callback: () => T,
): T {
  return requestStorage.run(context, callback);
}

export function recordPrismaQuery(sample: RecordedPrismaQuery): void {
  const context = requestStorage.getStore();
  if (!context) return;

  context.queryCount += 1;
  context.queryDurationMs += sample.durationMs;
  context.queryIntervals.push({
    startedAtMs: sample.startedAtMs,
    endedAtMs: sample.endedAtMs,
  });
  context.slowestQueries.push({
    model: sample.model,
    operation: sample.operation,
    durationMs: sample.durationMs,
  });
  context.slowestQueries.sort((left, right) => right.durationMs - left.durationMs);
  if (context.slowestQueries.length > MAX_SLOW_QUERY_SAMPLES) {
    context.slowestQueries.length = MAX_SLOW_QUERY_SAMPLES;
  }
}

export function recordRequestPerformanceSpan(name: string, durationMs: number): void {
  const context = requestStorage.getStore();
  if (!context || !Number.isFinite(durationMs) || durationMs < 0) return;
  const current = context.spans[name] ?? { count: 0, durationMs: 0 };
  current.count += 1;
  current.durationMs += durationMs;
  context.spans[name] = current;
}

export async function measureRequestPerformanceSpan<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordRequestPerformanceSpan(name, performance.now() - startedAt);
  }
}

export function recordCacheOutcome(outcome: CacheOutcome): void {
  const context = requestStorage.getStore();
  if (!context) return;
  context.cacheOutcomes[outcome] += 1;
}

export function getRequestPerformanceContext(): RequestPerformanceContext | undefined {
  return requestStorage.getStore();
}

/**
 * Sum the union of database-query intervals instead of summing each duration.
 * Independent Prisma calls can overlap, so cumulative query duration can be much
 * larger than the time the request actually spent waiting on PostgreSQL.
 */
export function getPrismaQueryWallTimeMs(context: RequestPerformanceContext): number {
  if (context.queryIntervals.length === 0) return 0;

  const intervals = [...context.queryIntervals].sort(
    (left, right) => left.startedAtMs - right.startedAtMs,
  );
  let currentStart = intervals[0]!.startedAtMs;
  let currentEnd = intervals[0]!.endedAtMs;
  let totalMs = 0;

  for (const interval of intervals.slice(1)) {
    if (interval.startedAtMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endedAtMs);
      continue;
    }
    totalMs += currentEnd - currentStart;
    currentStart = interval.startedAtMs;
    currentEnd = interval.endedAtMs;
  }

  return totalMs + (currentEnd - currentStart);
}
