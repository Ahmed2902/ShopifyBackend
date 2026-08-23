import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { MetaController } from './meta.controller.js';
import { metaMappingService, metaService } from './meta.module.js';

const controller = new MetaController(metaService, metaMappingService);
const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const metaRouter = Router();
metaRouter.get('/callback', controller.completeInstall);

export const metaStoreRouter = Router({ mergeParams: true });
metaStoreRouter.use(requireAuth, requireStoreMembership);

metaStoreRouter.get('/status', controller.status);
metaStoreRouter.get('/assets', controller.assets);
metaStoreRouter.get('/ad-accounts', controller.adAccounts);
metaStoreRouter.get('/campaigns', controller.campaigns);
metaStoreRouter.get('/adsets', controller.adSets);
metaStoreRouter.get('/ads', controller.ads);
metaStoreRouter.get('/ads/:adId', controller.ad);
metaStoreRouter.get('/catalogs', controller.catalogs);
metaStoreRouter.get('/catalogs/:catalogId/items', controller.catalogItems);
metaStoreRouter.get('/insights', controller.insights);
metaStoreRouter.get('/mappings/summary', controller.mappingSummary);
metaStoreRouter.get('/mappings/ads', controller.mappingAds);
metaStoreRouter.get('/mappings/ads/:adId/suggestions', controller.mappingSuggestions);

metaStoreRouter.post('/install', ownerOrAdmin, controller.startInstall);
metaStoreRouter.post('/configure', ownerOrAdmin, controller.configure);
metaStoreRouter.post('/catalogs/configure', ownerOrAdmin, controller.configureCatalogs);
metaStoreRouter.post('/sync', ownerOrAdmin, controller.sync);
metaStoreRouter.post('/catalogs/sync', ownerOrAdmin, controller.syncCatalogs);
metaStoreRouter.post('/insights/sync', ownerOrAdmin, controller.syncInsights);
metaStoreRouter.post('/mappings/resolve', ownerOrAdmin, controller.mappingResolve);
metaStoreRouter.put('/mappings/ads/:adId', ownerOrAdmin, controller.mappingReplaceAd);
metaStoreRouter.post('/mappings/ads/:adId/confirm', ownerOrAdmin, controller.mappingConfirmAd);
metaStoreRouter.put(
  '/mappings/catalog-items/:itemId',
  ownerOrAdmin,
  controller.mappingReplaceCatalogItem,
);
