import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireAdProviderEntitlement } from '../billing/billing.middleware.js';
import { metaMappingController } from './mapping/meta-mapping.controller.js';
import { metaController } from './meta.controller.js';
import { metaTrackingController } from './tracking/meta-tracking.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const metaRouter = Router();
metaRouter.get('/callback', metaController.completeInstall);

export const metaStoreRouter = Router({ mergeParams: true });
metaStoreRouter.use(requireAuth, requireStoreMembership);

// Keep status readable after a trial expires or when Essentials selected TikTok.
metaStoreRouter.get('/status', metaController.status);
// Every other Meta read/write is paid-provider access and must respect the selected channel.
metaStoreRouter.use(requireAdProviderEntitlement('META'));

metaStoreRouter.get('/assets', ownerOrAdmin, metaController.assets);
metaStoreRouter.get('/ad-accounts', metaController.adAccounts);
metaStoreRouter.get('/campaigns', metaController.campaigns);
metaStoreRouter.get('/adsets', metaController.adSets);
metaStoreRouter.get('/ads', metaController.ads);
metaStoreRouter.get('/ads/:adId', metaController.ad);
metaStoreRouter.get('/catalogs', metaController.catalogs);
metaStoreRouter.get('/catalogs/:catalogId/items', metaController.catalogItems);
metaStoreRouter.get('/insights', metaController.insights);
metaStoreRouter.get('/mappings/summary', metaMappingController.summary);
metaStoreRouter.get('/mappings/ads', metaMappingController.ads);
metaStoreRouter.get('/mappings/ads/:adId', metaMappingController.ad);
metaStoreRouter.get('/mappings/ads/:adId/suggestions', metaMappingController.suggestions);
metaStoreRouter.get('/tracking', ownerOrAdmin, metaTrackingController.audit);
metaStoreRouter.get('/tracking/manual', ownerOrAdmin, metaTrackingController.manualConfiguration);

metaStoreRouter.post('/install', ownerOrAdmin, metaController.startInstall);
metaStoreRouter.post('/configure', ownerOrAdmin, metaController.configure);
metaStoreRouter.post('/catalogs/configure', ownerOrAdmin, metaController.configureCatalogs);
metaStoreRouter.post('/sync', ownerOrAdmin, metaController.sync);
metaStoreRouter.post('/catalogs/sync', ownerOrAdmin, metaController.syncCatalogs);
metaStoreRouter.post('/insights/sync', ownerOrAdmin, metaController.syncInsights);
metaStoreRouter.post('/mappings/resolve', ownerOrAdmin, metaMappingController.resolve);
metaStoreRouter.post('/tracking/permission', ownerOrAdmin, metaTrackingController.permissionUpgrade);
metaStoreRouter.post('/tracking/apply', ownerOrAdmin, metaTrackingController.apply);
metaStoreRouter.put('/mappings/ads/:adId', ownerOrAdmin, metaMappingController.replaceAd);
metaStoreRouter.post('/mappings/ads/:adId/confirm', ownerOrAdmin, metaMappingController.confirmAd);
metaStoreRouter.put(
  '/mappings/catalog-items/:itemId',
  ownerOrAdmin,
  metaMappingController.replaceCatalogItem,
);
