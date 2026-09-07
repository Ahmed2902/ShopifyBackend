import type { Request, Response } from 'express';
import { CachedReadCoordinator, RedisJsonCache } from '../../lib/redis-json-cache.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsRangeQuerySchema,
  analyticsReadControlSchema,
  type AnalyticsRangeQuery,
} from './analytics.schema.js';
import { reportWorkspace, type ReportWorkspace } from './report.workspace.js';

const REPORT_CACHE_TTL_SECONDS = 30;
const reportReads = new CachedReadCoordinator(
  new RedisJsonCache('analytics:report:v1', REPORT_CACHE_TTL_SECONDS),
  250,
);

function cacheKey(storeId: string, query: AnalyticsRangeQuery): string {
  return [storeId, query.from ?? '', query.to ?? '', String(query.days)].join(':');
}

export class ReportController {
  constructor(private readonly workspace: ReportWorkspace) {}

  read = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await reportReads.run(
      cacheKey(storeId, query),
      async () => toJsonSafe(await this.workspace.read(storeId, query, new Date(), { fresh })),
      { fresh },
    );
    res.status(200).json(payload);
  };
}

export const reportController = new ReportController(reportWorkspace);
