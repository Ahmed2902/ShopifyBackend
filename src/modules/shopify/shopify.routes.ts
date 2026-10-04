import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth, requireShopifyAppAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { shopifyCollectionController } from './collection/shopify-collection.controller.js';
import { shopifyPrivacyController } from './privacy/shopify-privacy.controller.js';
import { shopifyReadController } from './read/shopify-read.controller.js';
import { shopifyController } from './shopify.controller.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const shopifyRouter = Router();
shopifyRouter.post('/webhooks', shopifyController.webhook);
// Shopify-native entry point. App Bridge sends its short-lived ID token in Authorization and this
// call provisions/recover the Store + staff mapping before the frontend makes store-scoped reads.
shopifyRouter.post('/session/bootstrap', requireShopifyAppAuth, shopifyController.sessionBootstrap);
// Temporary migration bridge for the pre-embedded frontend. Do not use this path from the App Store.
const legacyInstallOnly: RequestHandler = (_req, _res, next) => {
  if (!env.LEGACY_MERCHANT_AUTH_ENABLED) throw new AppError('Install Metrico through Shopify.', 410, 'SHOPIFY_INSTALL_REQUIRED');
  next();
};
shopifyRouter.post('/install', legacyInstallOnly, requireAuth, shopifyController.install);
shopifyRouter.get('/callback', legacyInstallOnly, shopifyController.callback);

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
shopifyStoreRouter.post(
  '/collections/:collectionId/products',
  ownerOrAdmin,
  shopifyCollectionController.addProducts,
);
shopifyStoreRouter.post('/sync', ownerOrAdmin, shopifyController.sync);
shopifyStoreRouter.get('/sync/:syncRunId', ownerOrAdmin, shopifyController.getSync);
shopifyStoreRouter.post('/orders/backfill', ownerOrAdmin, shopifyController.startOrderBackfill);
shopifyStoreRouter.get('/orders/backfill/:syncRunId', ownerOrAdmin, shopifyController.getOrderBackfill);
