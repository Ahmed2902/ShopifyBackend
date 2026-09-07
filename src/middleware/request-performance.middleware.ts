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
    res.once('finish', () => {
      const durationMs = roundMs(performance.now() - context.startedAtMs);
      const prismaQueryDurationMs = roundMs(context.queryDurationMs);
      const prismaQueryWallTimeMs = roundMs(getPrismaQueryWallTimeMs(context));
      const nonDatabaseDurationMs = roundMs(Math.max(0, durationMs - prismaQueryWallTimeMs));
      const slow = durationMs >= env.SLOW_REQUEST_THRESHOLD_MS;
      const payload = {
        event: slow ? 'slow_request' : 'request_performance',
        requestId,
        method: req.method,
        path: req.path || req.originalUrl.split('?', 1)[0] || '/',
        statusCode: res.statusCode,
        durationMs,
        prismaQueryCount: context.queryCount,
        prismaQueryDurationMs,
        prismaQueryWallTimeMs,
        nonDatabaseDurationMs,
        ...(slow ? { slowestQueries: context.slowestQueries } : {}),
      };

      if (slow) logger.warn(payload, 'Slow request');
      else if (env.LOG_REQUEST_PERFORMANCE) logger.info(payload, 'Request performance');
    });

    next();
  });
};
