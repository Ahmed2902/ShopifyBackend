import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { logger } from '../lib/logger.js';

interface QueryInterval {
  startedAtMs: number;
  endedAtMs: number;
}

interface SlowQuery {
  model: string | null;
  operation: string;
  durationMs: number;
}

interface OperationPerformanceContext {
  name: string;
  startedAtMs: number;
  queryCount: number;
  queryDurationMs: number;
  queryIntervals: QueryInterval[];
  slowestQueries: SlowQuery[];
  metadata: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<OperationPerformanceContext>();
const MAX_SLOW_QUERIES = 5;

function wallTime(intervals: QueryInterval[]): number {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((a, b) => a.startedAtMs - b.startedAtMs);
  let start = ordered[0]!.startedAtMs;
  let end = ordered[0]!.endedAtMs;
  let total = 0;
  for (const interval of ordered.slice(1)) {
    if (interval.startedAtMs <= end) {
      end = Math.max(end, interval.endedAtMs);
      continue;
    }
    total += end - start;
    start = interval.startedAtMs;
    end = interval.endedAtMs;
  }
  return total + end - start;
}

export function recordOperationPrismaQuery(sample: SlowQuery & QueryInterval): void {
  const context = storage.getStore();
  if (!context) return;
  context.queryCount += 1;
  context.queryDurationMs += sample.durationMs;
  context.queryIntervals.push({ startedAtMs: sample.startedAtMs, endedAtMs: sample.endedAtMs });
  context.slowestQueries.push({
    model: sample.model,
    operation: sample.operation,
    durationMs: sample.durationMs,
  });
  context.slowestQueries.sort((a, b) => b.durationMs - a.durationMs);
  context.slowestQueries.length = Math.min(context.slowestQueries.length, MAX_SLOW_QUERIES);
}

export async function profileBackgroundOperation<T>(
  name: string,
  metadata: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const context: OperationPerformanceContext = {
    name,
    startedAtMs: performance.now(),
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
    metadata,
  };

  return storage.run(context, async () => {
    let failed = false;
    try {
      return await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const durationMs = performance.now() - context.startedAtMs;
      const prismaQueryWallTimeMs = wallTime(context.queryIntervals);
      logger.info(
        {
          event: 'background_operation_performance',
          operation: name,
          failed,
          durationMs: Math.round(durationMs * 100) / 100,
          prismaQueryCount: context.queryCount,
          prismaQueryDurationMs: Math.round(context.queryDurationMs * 100) / 100,
          prismaQueryWallTimeMs: Math.round(prismaQueryWallTimeMs * 100) / 100,
          nonDatabaseDurationMs:
            Math.round(Math.max(0, durationMs - prismaQueryWallTimeMs) * 100) / 100,
          slowestQueries: context.slowestQueries,
          ...metadata,
        },
        'Background operation performance',
      );
    }
  });
}
