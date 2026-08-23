import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { ShopifyReadController } from './read/shopify-read.controller.js';
import { ShopifyController } from './shopify.controller.js';
import { shopifyReadService, shopifyService } from './shopify.module.js';

const controller = new ShopifyController(shopifyService);
const readController = new ShopifyReadController(shopifyReadService);

export const shopifyRouter = Router();
shopifyRouter.post('/webhooks', controller.receiveWebhook);
shopifyRouter.post('/install', requireAuth, controller.startInstall);
shopifyRouter.get('/callback', controller.completeInstall);

export const shopifyStoreRouter = Router({ mergeParams: true });
shopifyStoreRouter.use(requireAuth, requireStoreMembership);

shopifyStoreRouter.get('/status', readController.status);
shopifyStoreRouter.get('/summary', readController.summary);
shopifyStoreRouter.get('/products', readController.products);
shopifyStoreRouter.get('/products/:productId/sales', readController.productSales);
shopifyStoreRouter.get('/products/:productId', readController.product);
shopifyStoreRouter.get('/inventory', readController.inventory);
shopifyStoreRouter.get('/locations', readController.locations);
shopifyStoreRouter.get('/orders', readController.orders);
shopifyStoreRouter.get('/orders/:orderId', readController.order);

shopifyStoreRouter.post(
  '/sync',
  requireRole('OWNER', 'ADMIN'),
  controller.syncCatalogAndInventory,
);
shopifyStoreRouter.post(
  '/orders/backfill',
  requireRole('OWNER', 'ADMIN'),
  controller.startOrderHistoryImport,
);
shopifyStoreRouter.get(
  '/orders/backfill/:syncRunId',
  requireRole('OWNER', 'ADMIN'),
  controller.getOrderHistoryImportStatus,
);
