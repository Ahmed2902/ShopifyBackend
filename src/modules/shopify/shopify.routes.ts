import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { IntegrationRepository } from '../integrations/integration.repository.js';
import { IntegrationService } from '../integrations/integration.service.js';
import { ShopifyController } from './shopify.controller.js';
import { ShopifyOrderRepository } from './order/shopify-order.repository.js';
import { ShopifyRepository } from './shopify.repository.js';
import { ShopifyService } from './shopify.service.js';

const integrationService = new IntegrationService(new IntegrationRepository());
const service = new ShopifyService(
  new ShopifyRepository(),
  integrationService,
  new ShopifyOrderRepository(),
);
const controller = new ShopifyController(service);

export const shopifyRouter = Router();
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
