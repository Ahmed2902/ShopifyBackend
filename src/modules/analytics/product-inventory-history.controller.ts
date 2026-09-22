import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import { analyticsEntityParamsSchema, analyticsRangeQuerySchema } from './analytics.schema.js';
import { productInventoryHistoryReadService } from './product-inventory-history.read.service.js';

function productId(req: Request) {
  return analyticsEntityParamsSchema.parse({ entityId: req.params.productId }).entityId;
}

export class ProductInventoryHistoryController {
  read = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await productInventoryHistoryReadService.read(
          req.context.storeId!,
          productId(req),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };
}

export const productInventoryHistoryController = new ProductInventoryHistoryController();
