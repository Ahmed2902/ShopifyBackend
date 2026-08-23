import type { Request, Response } from 'express';
import {
  shopifyInventoryQuerySchema,
  shopifyOrderParamsSchema,
  shopifyOrdersQuerySchema,
  shopifyProductParamsSchema,
  shopifyProductSalesQuerySchema,
  shopifyProductsQuerySchema,
  shopifySummaryQuerySchema,
} from './shopify-read.schema.js';
import { shopifyReadService, type ShopifyReadService } from './shopify-read.service.js';

export class ShopifyReadController {
  constructor(private readonly service: ShopifyReadService) {}

  status = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getStatus(req.context.storeId!));
  };

  summary = async (req: Request, res: Response) => {
    const query = shopifySummaryQuerySchema.parse(req.query);
    res.status(200).json(await this.service.getSummary(req.context.storeId!, query));
  };

  products = async (req: Request, res: Response) => {
    const query = shopifyProductsQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listProducts(req.context.storeId!, query));
  };

  product = async (req: Request, res: Response) => {
    const { productId } = shopifyProductParamsSchema.parse(req.params);
    res.status(200).json(await this.service.getProduct(req.context.storeId!, productId));
  };

  productSales = async (req: Request, res: Response) => {
    const { productId } = shopifyProductParamsSchema.parse(req.params);
    const query = shopifyProductSalesQuerySchema.parse(req.query);
    res.status(200).json(await this.service.getProductSales(req.context.storeId!, productId, query));
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

export const shopifyReadController = new ShopifyReadController(shopifyReadService);
