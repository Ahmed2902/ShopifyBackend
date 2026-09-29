import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  analyticsEntityParamsSchema,
  analyticsRangeQuerySchema,
} from '../../analytics/analytics.schema.js';
import { pixelEntityDetailService } from './pixel-entity-detail.service.js';

const entityIdsSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).min(1).max(100));

function entityId(req: Request, key: 'productId' | 'collectionId') {
  return analyticsEntityParamsSchema.parse({ entityId: req.params[key] }).entityId;
}

export class PixelEntityDetailController {
  productBatch = async (req: Request, res: Response) => {
    const ids = [...new Set(entityIdsSchema.parse(req.query.ids))];
    const query = analyticsRangeQuerySchema.parse(req.query);
    res.status(200).json(await pixelEntityDetailService.batch(req.context.storeId!, 'PRODUCT', ids, query));
  };

  product = async (req: Request, res: Response) => {
    res.status(200).json(
      await pixelEntityDetailService.detail(
        req.context.storeId!,
        'PRODUCT',
        entityId(req, 'productId'),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  productSources = async (req: Request, res: Response) => {
    res.status(200).json(
      await pixelEntityDetailService.sources(
        req.context.storeId!,
        'PRODUCT',
        entityId(req, 'productId'),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  collectionBatch = async (req: Request, res: Response) => {
    const ids = [...new Set(entityIdsSchema.parse(req.query.ids))];
    const query = analyticsRangeQuerySchema.parse(req.query);
    res.status(200).json(await pixelEntityDetailService.batch(req.context.storeId!, 'COLLECTION', ids, query));
  };

  collection = async (req: Request, res: Response) => {
    res.status(200).json(
      await pixelEntityDetailService.detail(
        req.context.storeId!,
        'COLLECTION',
        entityId(req, 'collectionId'),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  collectionSources = async (req: Request, res: Response) => {
    res.status(200).json(
      await pixelEntityDetailService.sources(
        req.context.storeId!,
        'COLLECTION',
        entityId(req, 'collectionId'),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };
}

export const pixelEntityDetailController = new PixelEntityDetailController();
