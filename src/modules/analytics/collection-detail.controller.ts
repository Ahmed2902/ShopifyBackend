import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import { analyticsEntityParamsSchema } from './analytics.schema.js';
import { collectionDetailReadService } from './collection-detail.read.service.js';

function collectionId(req: Request) {
  return analyticsEntityParamsSchema.parse({ entityId: req.params.collectionId }).entityId;
}

export class CollectionDetailController {
  read = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await collectionDetailReadService.read(req.context.storeId!, collectionId(req)),
      ),
    );
  };
}

export const collectionDetailController = new CollectionDetailController();
