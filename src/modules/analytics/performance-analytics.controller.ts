import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import { analyticsRangeQuerySchema } from './analytics.schema.js';
import {
  performanceAnalyticsWorkspace,
  type PerformanceAnalyticsWorkspace,
} from './performance-analytics.workspace.js';

export class PerformanceAnalyticsController {
  constructor(private readonly workspace: PerformanceAnalyticsWorkspace) {}

  daily = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.daily(
          req.context.storeId!,
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };
}

export const performanceAnalyticsController = new PerformanceAnalyticsController(
  performanceAnalyticsWorkspace,
);
