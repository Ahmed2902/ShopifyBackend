import type { Request, Response } from 'express';
import { z } from 'zod';
import { shopifyCollectionService } from './shopify-collection.service.js';

const createCollectionSchema = z.object({
  title: z.string().trim().min(1).max(255),
});

const addCollectionProductsSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(250),
});

const collectionIdSchema = z.string().uuid();

export class ShopifyCollectionController {
  create = async (req: Request, res: Response) => {
    const { title } = createCollectionSchema.parse(req.body);
    const result = await shopifyCollectionService.create(req.context.storeId!, title);
    res.status(201).json(result);
  };

  addProducts = async (req: Request, res: Response) => {
    const collectionId = collectionIdSchema.parse(req.params.collectionId);
    const { productIds } = addCollectionProductsSchema.parse(req.body);
    const result = await shopifyCollectionService.addProducts(
      req.context.storeId!,
      collectionId,
      [...new Set(productIds)],
    );
    res.status(200).json(result);
  };
}

export const shopifyCollectionController = new ShopifyCollectionController();
