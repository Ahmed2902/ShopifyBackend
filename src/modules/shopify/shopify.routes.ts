import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { shopifyReadController } from './read/shopify-read.controller.js';
import { shopifyController } from './shopify.controller.js';

export const shopifyRouter = Router();
shopifyRouter.post('/webhooks', shopifyController.webhook);
shopifyRouter.post('/install', requireAuth, shopifyController.install);
shopifyRouter.get('/callback', shopifyController.callback);

export const shopifyStoreRouter = Router({ mergeParams: true });
shopifyStoreRouter.use(requireAuth, requireStoreMembership);

shopifyStoreRouter.get('/status', shopifyReadController.status);
shopifyStoreRouter.get('/summary', shopifyReadController.summary);
shopifyStoreRouter.get('/products', shopifyReadController.products);
shopifyStoreRouter.get('/products/:productId/sales', shopifyReadController.productSales);
shopifyStoreRouter.get('/products/:productId', shopifyReadController.product);
shopifyStoreRouter.get('/inventory', shopifyReadController.inventory);
shopifyStoreRouter.get('/locations', shopifyReadController.locations);
shopifyStoreRouter.get('/orders', shopifyReadController.orders);
shopifyStoreRouter.get('/orders/:orderId', shopifyReadController.order);

shopifyStoreRouter.post('/sync', requireRole('OWNER', 'ADMIN'), shopifyController.sync);
shopifyStoreRouter.post(
  '/orders/backfill',
  requireRole('OWNER', 'ADMIN'),
  shopifyController.startOrderBackfill,
);
shopifyStoreRouter.get(
  '/orders/backfill/:syncRunId',
  requireRole('OWNER', 'ADMIN'),
  shopifyController.getOrderBackfill,
);
