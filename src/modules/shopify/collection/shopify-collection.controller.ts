import type { Request, Response } from 'express';
import { z } from 'zod';
import { shopifyCollectionService } from './shopify-collection.service.js';

const createCollectionSchema = z.object({
  title: z.string().trim().min(1).max(255),
});

export class ShopifyCollectionController {
  create = async (req: Request, res: Response) => {
    const { title } = createCollectionSchema.parse(req.body);
    const result = await shopifyCollectionService.create(req.context.storeId!, title);
    res.status(201).json(result);
  };
}

export const shopifyCollectionController = new ShopifyCollectionController();
