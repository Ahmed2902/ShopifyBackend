import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsEntityParamsSchema,
  analyticsListQuerySchema,
} from './analytics.schema.js';
import { collectionDetailReadService } from './collection-detail.read.service.js';

function collectionId(req: Request) {
  return analyticsEntityParamsSchema.parse({ entityId: req.params.collectionId }).entityId;
}

export class CollectionDetailController {
  read = async (req: Request, res: Response) => {
    const { page, limit } = analyticsListQuerySchema.parse(req.query);
    res.status(200).json(
      toJsonSafe(
        await collectionDetailReadService.read(
          req.context.storeId!,
          collectionId(req),
          page,
          limit,
        ),
      ),
    );
  };
}

export const collectionDetailController = new CollectionDetailController();
