import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import { analyticsEntityParamsSchema, analyticsRangeQuerySchema } from './analytics.schema.js';
import { collectionPerformanceReadService } from './collection-performance.read.service.js';

function collectionId(req: Request) {
  return analyticsEntityParamsSchema.parse({ entityId: req.params.collectionId }).entityId;
}

export class CollectionPerformanceController {
  read = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await collectionPerformanceReadService.read(
          req.context.storeId!,
          collectionId(req),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };
}

export const collectionPerformanceController = new CollectionPerformanceController();
