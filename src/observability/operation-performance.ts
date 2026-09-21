import { performance } from 'node:perf_hooks';
import { logger } from '../lib/logger.js';
import {
  getPrismaQueryWallTimeMs,
  runWithRequestPerformanceContext,
  type RequestPerformanceContext,
} from './request-performance.js';

/**
 * Background work reuses the same Prisma query instrumentation already installed for HTTP requests.
 * This avoids a second observer inside `lib/prisma.ts`, keeping pool/client construction independent
 * from worker profiling. Extra cache/span fields make this context forward-compatible with the richer
 * request telemetry stack; older request-performance types safely ignore them.
 */
function backgroundQueryContext(name: string, startedAtMs: number): RequestPerformanceContext {
  return {
    requestId: `background:${name}`,
    startedAtMs,
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
    spans: {},
    cacheOutcomes: { hit: 0, miss: 0, bypass: 0, error: 0, fresh: 0, coalesced: 0 },
    memoizedReads: new Map(),
  } as unknown as RequestPerformanceContext;
}

export async function profileBackgroundOperation<T>(
  name: string,
  metadata: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAtMs = performance.now();
  const context = backgroundQueryContext(name, startedAtMs);

  return runWithRequestPerformanceContext(context, async () => {
    let failed = false;
    try {
      return await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAtMs;
      const prismaQueryWallTimeMs = getPrismaQueryWallTimeMs(context);
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
