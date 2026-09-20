import type { RequestHandler } from 'express';
import { performance } from 'node:perf_hooks';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { resolvePerformanceBudget } from '../observability/performance-budget.js';
import {
  getPrismaQueryWallTimeMs,
  runWithRequestPerformanceContext,
  type RequestPerformanceContext,
} from '../observability/request-performance.js';

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function requestIdFromResponse(value: string | number | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? 'unknown';
  if (value === undefined) return 'unknown';
  return String(value);
}

function roundedSpans(context: RequestPerformanceContext) {
  return Object.fromEntries(
    Object.entries(context.spans).map(([name, span]) => [
      name,
      { count: span.count, durationMs: roundMs(span.durationMs) },
    ]),
  );
}

export const requestPerformanceMiddleware: RequestHandler = (req, res, next) => {
  const requestId = requestIdFromResponse(res.getHeader('x-request-id'));
  const context: RequestPerformanceContext = {
    requestId,
    startedAtMs: performance.now(),
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
    spans: {},
    cacheOutcomes: { hit: 0, miss: 0, bypass: 0, error: 0, fresh: 0 },
    memoizedReads: new Map(),
  };

  runWithRequestPerformanceContext(context, () => {
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;

      const durationMs = roundMs(performance.now() - context.startedAtMs);
      const prismaQueryDurationMs = roundMs(context.queryDurationMs);
      const prismaQueryWallTimeMs = roundMs(getPrismaQueryWallTimeMs(context));
      const nonDatabaseDurationMs = roundMs(Math.max(0, durationMs - prismaQueryWallTimeMs));
      const rawPath = req.originalUrl.split('?', 1)[0] || req.path || '/';
      const budget = resolvePerformanceBudget(req.method, rawPath);
      const durationBudgetExceeded = budget ? durationMs > budget.maxDurationMs : false;
      const queryBudgetExceeded = budget ? context.queryCount > budget.maxPrismaQueries : false;
      const budgetExceeded = durationBudgetExceeded || queryBudgetExceeded;
      const slow = durationMs >= env.SLOW_REQUEST_THRESHOLD_MS;
      const payload = {
        event: aborted
          ? 'aborted_request'
          : budgetExceeded
            ? 'performance_budget_exceeded'
            : slow
              ? 'slow_request'
              : 'request_performance',
        requestId,
        method: req.method,
        path: rawPath,
        statusCode: res.statusCode,
        aborted,
        durationMs,
        prismaQueryCount: context.queryCount,
        prismaQueryDurationMs,
        prismaQueryWallTimeMs,
        nonDatabaseDurationMs,
        spans: roundedSpans(context),
        cacheOutcomes: context.cacheOutcomes,
        ...(budget
          ? {
              performanceBudget: budget,
              budgetExceeded,
              durationBudgetExceeded,
              queryBudgetExceeded,
            }
          : {}),
        ...(slow || aborted || budgetExceeded ? { slowestQueries: context.slowestQueries } : {}),
      };

      if (aborted) logger.warn(payload, 'Aborted request');
      else if (budgetExceeded) logger.warn(payload, 'Performance budget exceeded');
      else if (slow) logger.warn(payload, 'Slow request');
      else if (env.LOG_REQUEST_PERFORMANCE) logger.info(payload, 'Request performance');
    };

    res.once('finish', () => record(false));
    res.once('close', () => {
      record(!res.writableFinished);
    });

    next();
  });
};
