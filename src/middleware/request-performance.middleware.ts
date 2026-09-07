import type { RequestHandler } from 'express';
import { performance } from 'node:perf_hooks';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
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

export const requestPerformanceMiddleware: RequestHandler = (req, res, next) => {
  const requestId = requestIdFromResponse(res.getHeader('x-request-id'));
  const context: RequestPerformanceContext = {
    requestId,
    startedAtMs: performance.now(),
    queryCount: 0,
    queryDurationMs: 0,
    queryIntervals: [],
    slowestQueries: [],
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
      const slow = durationMs >= env.SLOW_REQUEST_THRESHOLD_MS;
      const payload = {
        event: aborted ? 'aborted_request' : slow ? 'slow_request' : 'request_performance',
        requestId,
        method: req.method,
        path: req.path || req.originalUrl.split('?', 1)[0] || '/',
        statusCode: res.statusCode,
        aborted,
        durationMs,
        prismaQueryCount: context.queryCount,
        prismaQueryDurationMs,
        prismaQueryWallTimeMs,
        nonDatabaseDurationMs,
        ...(slow || aborted ? { slowestQueries: context.slowestQueries } : {}),
      };

      if (aborted) logger.warn(payload, 'Aborted request');
      else if (slow) logger.warn(payload, 'Slow request');
      else if (env.LOG_REQUEST_PERFORMANCE) logger.info(payload, 'Request performance');
    };

    res.once('finish', () => record(false));
    res.once('close', () => {
      // A normal completed response emits finish before close. The guard avoids double logging,
      // while an early disconnect still records the DB work and elapsed time spent before abort.
      record(!res.writableFinished);
    });

    next();
  });
};
