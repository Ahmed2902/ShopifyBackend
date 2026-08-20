import type { Request, Response } from 'express';
import type { ShopifyReadService } from './shopify-read.service.js';
import {
  shopifyInventoryQuerySchema,
  shopifyOrderParamsSchema,
  shopifyOrdersQuerySchema,
  shopifyProductParamsSchema,
  shopifyProductsQuerySchema,
} from './shopify-read.schema.js';

export class ShopifyReadController {
  constructor(private readonly service: ShopifyReadService) {}

  status = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getStatus(req.context.storeId!));
  };

  products = async (req: Request, res: Response) => {
    const query = shopifyProductsQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listProducts(req.context.storeId!, query));
  };

  product = async (req: Request, res: Response) => {
    const { productId } = shopifyProductParamsSchema.parse(req.params);
    res.status(200).json(await this.service.getProduct(req.context.storeId!, productId));
  };

  inventory = async (req: Request, res: Response) => {
    const query = shopifyInventoryQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listInventory(req.context.storeId!, query));
  };

  locations = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.listLocations(req.context.storeId!));
  };

  orders = async (req: Request, res: Response) => {
    const query = shopifyOrdersQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listOrders(req.context.storeId!, query));
  };

  order = async (req: Request, res: Response) => {
    const { orderId } = shopifyOrderParamsSchema.parse(req.params);
    res.status(200).json(await this.service.getOrder(req.context.storeId!, orderId));
  };
}
