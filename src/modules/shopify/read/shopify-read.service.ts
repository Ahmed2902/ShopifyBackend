import { AppError } from '../../../errors/app-error.js';
import type { ShopifyMetricsRepository } from './shopify-metrics.repository.js';
import type { ShopifyReadRepository } from './shopify-read.repository.js';
import type {
  ShopifyInventoryQuery,
  ShopifyOrdersQuery,
  ShopifyProductSalesQuery,
  ShopifyProductsQuery,
  ShopifySummaryQuery,
} from './shopify-read.schema.js';

export class ShopifyReadService {
  constructor(
    private readonly repository: ShopifyReadRepository,
    private readonly metricsRepository: ShopifyMetricsRepository,
  ) {}

  async getStatus(storeId: string) {
    const status = await this.repository.getStatus(storeId);
    if (!status) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return status;
  }

  getSummary(storeId: string, query: ShopifySummaryQuery) {
    return this.metricsRepository.getSummary(storeId, query);
  }

  listProducts(storeId: string, query: ShopifyProductsQuery) {
    return this.repository.listProducts(storeId, query);
  }

  async getProduct(storeId: string, productId: string) {
    const product = await this.repository.getProduct(storeId, productId);
    if (!product) throw new AppError('Shopify product not found', 404, 'SHOPIFY_PRODUCT_NOT_FOUND');
    return product;
  }

  async getProductSales(storeId: string, productId: string, query: ShopifyProductSalesQuery) {
    const sales = await this.metricsRepository.getProductSales(storeId, productId, query);
    if (!sales) throw new AppError('Shopify product not found', 404, 'SHOPIFY_PRODUCT_NOT_FOUND');
    return sales;
  }

  listInventory(storeId: string, query: ShopifyInventoryQuery) {
    return this.repository.listInventory(storeId, query);
  }

  listLocations(storeId: string) {
    return this.repository.listLocations(storeId);
  }

  listOrders(storeId: string, query: ShopifyOrdersQuery) {
    return this.repository.listOrders(storeId, query);
  }

  async getOrder(storeId: string, orderId: string) {
    const order = await this.repository.getOrder(storeId, orderId);
    if (!order) throw new AppError('Shopify order not found', 404, 'SHOPIFY_ORDER_NOT_FOUND');
    return order;
  }
}
