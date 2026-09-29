import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  analyticsEntityParamsSchema,
  analyticsRangeQuerySchema,
} from './analytics.schema.js';
import { productDetailSupportService } from './product-detail-support.service.js';

const productImageIdsSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).min(1).max(100));

function productId(req: Request): string {
  return analyticsEntityParamsSchema.parse({ entityId: req.params.productId }).entityId;
}

export class ProductDetailSupportController {
  images = async (req: Request, res: Response) => {
    const ids = [...new Set(productImageIdsSchema.parse(req.query.ids))];
    res.status(200).json(await productDetailSupportService.images(req.context.storeId!, ids));
  };

  inventoryHistory = async (req: Request, res: Response) => {
    res.status(200).json(
      await productDetailSupportService.inventoryHistory(
        req.context.storeId!,
        productId(req),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };
}

export const productDetailSupportController = new ProductDetailSupportController();
