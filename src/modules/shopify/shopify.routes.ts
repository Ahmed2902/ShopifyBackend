import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { shopifyCollectionController } from './collection/shopify-collection.controller.js';
import { shopifyPrivacyController } from './privacy/shopify-privacy.controller.js';
import { shopifyReadController } from './read/shopify-read.controller.js';
import { shopifyController } from './shopify.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const shopifyRouter = Router();
shopifyRouter.post('/webhooks', shopifyController.webhook);
shopifyRouter.post('/install', requireAuth, shopifyController.install);
shopifyRouter.get('/callback', shopifyController.callback);

export const shopifyStoreRouter = Router({ mergeParams: true });
shopifyStoreRouter.use(requireAuth, requireStoreMembership);

// Status, disconnect and privacy exports stay reachable after expiry for recovery/compliance.
shopifyStoreRouter.get('/status', shopifyReadController.status);
shopifyStoreRouter.post('/disconnect', ownerOrAdmin, shopifyController.disconnect);
shopifyStoreRouter.get(
  '/privacy/data-requests',
  ownerOrAdmin,
  shopifyPrivacyController.listDataRequests,
);
shopifyStoreRouter.get(
  '/privacy/data-requests/:requestId',
  ownerOrAdmin,
  shopifyPrivacyController.getDataRequest,
);

shopifyStoreRouter.use(requireActiveSubscription);
shopifyStoreRouter.get('/summary', shopifyReadController.summary);
shopifyStoreRouter.get('/products', shopifyReadController.products);
shopifyStoreRouter.get('/products/:productId/sales', shopifyReadController.productSales);
shopifyStoreRouter.get('/products/:productId', shopifyReadController.product);
shopifyStoreRouter.get('/inventory', shopifyReadController.inventory);
shopifyStoreRouter.get('/locations', shopifyReadController.locations);
shopifyStoreRouter.get('/orders', shopifyReadController.orders);
shopifyStoreRouter.get('/orders/:orderId', shopifyReadController.order);

shopifyStoreRouter.post('/collections', ownerOrAdmin, shopifyCollectionController.create);
shopifyStoreRouter.post('/sync', ownerOrAdmin, shopifyController.sync);
shopifyStoreRouter.get('/sync/:syncRunId', ownerOrAdmin, shopifyController.getSync);
shopifyStoreRouter.post('/orders/backfill', ownerOrAdmin, shopifyController.startOrderBackfill);
shopifyStoreRouter.get('/orders/backfill/:syncRunId', ownerOrAdmin, shopifyController.getOrderBackfill);
