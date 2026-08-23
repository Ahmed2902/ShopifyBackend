import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { MetaMappingController } from './mapping/meta-mapping.controller.js';
import { MetaController } from './meta.controller.js';
import { metaMappingService, metaService } from './meta.module.js';

const controller = new MetaController(metaService);
const mappingController = new MetaMappingController(metaMappingService);
const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const metaRouter = Router();
metaRouter.get('/callback', controller.completeInstall);

export const metaStoreRouter = Router({ mergeParams: true });
metaStoreRouter.use(requireAuth, requireStoreMembership);

metaStoreRouter.get('/status', controller.status);
metaStoreRouter.get('/assets', ownerOrAdmin, controller.assets);
metaStoreRouter.get('/ad-accounts', controller.adAccounts);
metaStoreRouter.get('/campaigns', controller.campaigns);
metaStoreRouter.get('/adsets', controller.adSets);
metaStoreRouter.get('/ads', controller.ads);
metaStoreRouter.get('/ads/:adId', controller.ad);
metaStoreRouter.get('/catalogs', controller.catalogs);
metaStoreRouter.get('/catalogs/:catalogId/items', controller.catalogItems);
metaStoreRouter.get('/insights', controller.insights);
metaStoreRouter.get('/mappings/summary', mappingController.summary);
metaStoreRouter.get('/mappings/ads', mappingController.ads);
metaStoreRouter.get('/mappings/ads/:adId/suggestions', mappingController.suggestions);

metaStoreRouter.post('/install', ownerOrAdmin, controller.startInstall);
metaStoreRouter.post('/configure', ownerOrAdmin, controller.configure);
metaStoreRouter.post('/catalogs/configure', ownerOrAdmin, controller.configureCatalogs);
metaStoreRouter.post('/sync', ownerOrAdmin, controller.sync);
metaStoreRouter.post('/catalogs/sync', ownerOrAdmin, controller.syncCatalogs);
metaStoreRouter.post('/insights/sync', ownerOrAdmin, controller.syncInsights);
metaStoreRouter.post('/mappings/resolve', ownerOrAdmin, mappingController.resolve);
metaStoreRouter.put('/mappings/ads/:adId', ownerOrAdmin, mappingController.replaceAd);
metaStoreRouter.post('/mappings/ads/:adId/confirm', ownerOrAdmin, mappingController.confirmAd);
metaStoreRouter.put(
  '/mappings/catalog-items/:itemId',
  ownerOrAdmin,
  mappingController.replaceCatalogItem,
);
