import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireAdProviderEntitlement } from '../billing/billing.middleware.js';
import { tiktokMappingController } from './mapping/tiktok-mapping.controller.js';
import { tiktokController } from './tiktok.controller.js';
import { tiktokWebhookController } from './webhook/tiktok-webhook.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const tiktokRouter = Router();
tiktokRouter.get('/callback', tiktokController.completeInstall);
tiktokRouter.post('/webhooks', tiktokWebhookController.receive);

export const tiktokStoreRouter = Router({ mergeParams: true });
tiktokStoreRouter.use(requireAuth, requireStoreMembership);

// Status remains readable after access expires or when Essentials selected Meta.
tiktokStoreRouter.get('/status', tiktokController.status);
// Every other TikTok read/write is paid-provider access and must respect the selected channel.
tiktokStoreRouter.use(requireAdProviderEntitlement('TIKTOK'));

tiktokStoreRouter.get('/assets', ownerOrAdmin, tiktokController.assets);
tiktokStoreRouter.get('/campaigns', tiktokController.campaigns);
tiktokStoreRouter.get('/adgroups', tiktokController.adGroups);
tiktokStoreRouter.get('/ads', tiktokController.ads);
tiktokStoreRouter.get('/ads/:adId', tiktokController.ad);
tiktokStoreRouter.get('/catalogs', tiktokController.catalogs);
tiktokStoreRouter.get('/catalogs/:catalogId/items', tiktokController.catalogItems);
tiktokStoreRouter.get('/insights', tiktokController.insights);

tiktokStoreRouter.post('/install', ownerOrAdmin, tiktokController.startInstall);
tiktokStoreRouter.post('/configure', ownerOrAdmin, tiktokController.configure);
tiktokStoreRouter.post('/sync', ownerOrAdmin, tiktokController.sync);
tiktokStoreRouter.post('/catalogs/configure', ownerOrAdmin, tiktokController.configureCatalogs);
tiktokStoreRouter.post('/catalogs/sync', ownerOrAdmin, tiktokController.syncCatalogs);
tiktokStoreRouter.post('/insights/sync', ownerOrAdmin, tiktokController.syncInsights);
tiktokStoreRouter.post('/mappings/resolve', ownerOrAdmin, tiktokMappingController.resolve);
tiktokStoreRouter.put('/mappings/ads/:adId', ownerOrAdmin, tiktokMappingController.replaceAd);
tiktokStoreRouter.put(
  '/mappings/catalog-items/:catalogItemId',
  ownerOrAdmin,
  tiktokMappingController.replaceCatalogItem,
);
