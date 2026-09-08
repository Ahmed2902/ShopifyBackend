import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { shopifyPrivacyController } from './privacy/shopify-privacy.controller.js';
import { shopifyReadController } from './read/shopify-read.controller.js';
import { shopifyController } from './shopify.controller.js';

export const shopifyRouter = Router();
shopifyRouter.post('/webhooks', shopifyController.webhook);
shopifyRouter.post('/install', requireAuth, shopifyController.install);
shopifyRouter.get('/callback', shopifyController.callback);

export const shopifyStoreRouter = Router({ mergeParams: true });
shopifyStoreRouter.use(requireAuth, requireStoreMembership);

shopifyStoreRouter.get('/status', shopifyReadController.status);
shopifyStoreRouter.get('/summary', requireActiveSubscription, shopifyReadController.summary);
shopifyStoreRouter.get('/products', requireActiveSubscription, shopifyReadController.products);
shopifyStoreRouter.get('/products/:productId/sales', requireActiveSubscription, shopifyReadController.productSales);
shopifyStoreRouter.get('/products/:productId', requireActiveSubscription, shopifyReadController.product);
shopifyStoreRouter.get('/inventory', requireActiveSubscription, shopifyReadController.inventory);
shopifyStoreRouter.get('/locations', requireActiveSubscription, shopifyReadController.locations);
shopifyStoreRouter.get('/orders', requireActiveSubscription, shopifyReadController.orders);
shopifyStoreRouter.get('/orders/:orderId', requireActiveSubscription, shopifyReadController.order);
shopifyStoreRouter.get(
  '/privacy/data-requests',
  requireRole('OWNER', 'ADMIN'),
  shopifyPrivacyController.listDataRequests,
);
shopifyStoreRouter.get(
  '/privacy/data-requests/:requestId',
  requireRole('OWNER', 'ADMIN'),
  shopifyPrivacyController.getDataRequest,
);

shopifyStoreRouter.post('/sync', requireRole('OWNER', 'ADMIN'), requireActiveSubscription, shopifyController.sync);
shopifyStoreRouter.post(
  '/orders/backfill',
  requireRole('OWNER', 'ADMIN'),
  requireActiveSubscription,
  shopifyController.startOrderBackfill,
);
shopifyStoreRouter.get(
  '/orders/backfill/:syncRunId',
  requireRole('OWNER', 'ADMIN'),
  requireActiveSubscription,
  shopifyController.getOrderBackfill,
);
