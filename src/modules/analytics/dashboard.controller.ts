import type { Request, Response } from 'express';
import { dashboardCachedReads } from '../../lib/store-decision-cache.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsRangeQuerySchema,
  analyticsReadControlSchema,
  type AnalyticsRangeQuery,
} from './analytics.schema.js';
import { dashboardWorkspace, type DashboardWorkspace } from './dashboard.workspace.js';

export function dashboardCacheKey(storeId: string, query: AnalyticsRangeQuery): string {
  return [
    storeId,
    query.from ?? '',
    query.to ?? '',
    String(query.days),
    query.accountId ?? '',
  ].join(':');
}

export class DashboardController {
  constructor(private readonly workspace: DashboardWorkspace) {}

  read = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await dashboardCachedReads.run(
      dashboardCacheKey(storeId, query),
      async () => toJsonSafe(await this.workspace.read(storeId, query, new Date(), { fresh })),
      {
        fresh,
        // All date-range/account variants share one Store generation. Once a Store mutation or
        // manual Refresh advances that generation, no older scoped cache can become authoritative.
        versionScope: storeId,
      },
    );
    res.status(200).json(payload);
  };
}

export const dashboardController = new DashboardController(dashboardWorkspace);
