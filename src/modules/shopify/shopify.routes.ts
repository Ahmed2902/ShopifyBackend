import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { ShopifyController } from './shopify.controller.js';
import { shopifyService } from './shopify.module.js';

const controller = new ShopifyController(shopifyService);

export const shopifyRouter = Router();
shopifyRouter.post('/webhooks', controller.webhook);
shopifyRouter.post('/install', requireAuth, controller.install);
shopifyRouter.get('/callback', controller.callback);

export const shopifyStoreRouter = Router({ mergeParams: true });
shopifyStoreRouter.post(
  '/sync',
  requireAuth,
  requireStoreMembership,
  requireRole('OWNER', 'ADMIN'),
  controller.sync,
);
shopifyStoreRouter.post(
  '/orders/backfill',
  requireAuth,
  requireStoreMembership,
  requireRole('OWNER', 'ADMIN'),
  controller.startOrderBackfill,
);
shopifyStoreRouter.get(
  '/orders/backfill/:syncRunId',
  requireAuth,
  requireStoreMembership,
  requireRole('OWNER', 'ADMIN'),
  controller.getOrderBackfill,
);
