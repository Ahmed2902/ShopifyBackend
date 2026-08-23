import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { TikTokController } from './tiktok.controller.js';
import { tiktokService, tiktokWebhookService } from './tiktok.module.js';
import { TikTokWebhookController } from './webhook/tiktok-webhook.controller.js';

const controller = new TikTokController(tiktokService);
const webhookController = new TikTokWebhookController(tiktokWebhookService);
const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const tiktokRouter = Router();
tiktokRouter.get('/callback', controller.completeInstall);
tiktokRouter.post('/webhooks', webhookController.receive);

export const tiktokStoreRouter = Router({ mergeParams: true });
tiktokStoreRouter.use(requireAuth, requireStoreMembership);

tiktokStoreRouter.get('/status', controller.status);
tiktokStoreRouter.get('/assets', controller.assets);
tiktokStoreRouter.get('/campaigns', controller.campaigns);
tiktokStoreRouter.get('/adgroups', controller.adGroups);
tiktokStoreRouter.get('/ads', controller.ads);
tiktokStoreRouter.get('/ads/:adId', controller.ad);
tiktokStoreRouter.get('/catalogs', controller.catalogs);
tiktokStoreRouter.get('/catalogs/:catalogId/items', controller.catalogItems);
tiktokStoreRouter.get('/insights', controller.insights);

tiktokStoreRouter.post('/install', ownerOrAdmin, controller.startInstall);
tiktokStoreRouter.post('/configure', ownerOrAdmin, controller.configure);
tiktokStoreRouter.post('/sync', ownerOrAdmin, controller.sync);
tiktokStoreRouter.post('/catalogs/configure', ownerOrAdmin, controller.configureCatalogs);
tiktokStoreRouter.post('/catalogs/sync', ownerOrAdmin, controller.syncCatalogs);
tiktokStoreRouter.post('/insights/sync', ownerOrAdmin, controller.syncInsights);
tiktokStoreRouter.post('/mappings/resolve', ownerOrAdmin, controller.resolveMappings);
tiktokStoreRouter.put('/mappings/ads/:adId', ownerOrAdmin, controller.replaceAdMapping);
tiktokStoreRouter.put('/mappings/catalog-items/:catalogItemId', ownerOrAdmin, controller.replaceCatalogItemMapping);
