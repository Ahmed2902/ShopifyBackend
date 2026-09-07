import type { Request, Response } from 'express';
import { CachedReadCoordinator, RedisJsonCache } from '../../lib/redis-json-cache.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsRangeQuerySchema,
  analyticsReadControlSchema,
  type AnalyticsRangeQuery,
} from './analytics.schema.js';
import { dashboardWorkspace, type DashboardWorkspace } from './dashboard.workspace.js';

const DASHBOARD_CACHE_TTL_SECONDS = 30;
const dashboardReads = new CachedReadCoordinator(
  new RedisJsonCache('analytics:dashboard:v1', DASHBOARD_CACHE_TTL_SECONDS),
  250,
);

function cacheKey(storeId: string, query: AnalyticsRangeQuery): string {
  return [storeId, query.from ?? '', query.to ?? '', String(query.days)].join(':');
}

export class DashboardController {
  constructor(private readonly workspace: DashboardWorkspace) {}

  read = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await dashboardReads.run(
      cacheKey(storeId, query),
      async () => toJsonSafe(await this.workspace.read(storeId, query, new Date(), { fresh })),
      { fresh },
    );
    res.status(200).json(payload);
  };
}

export const dashboardController = new DashboardController(dashboardWorkspace);
