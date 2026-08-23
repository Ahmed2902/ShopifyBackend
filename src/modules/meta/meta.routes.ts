import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { MetaController } from './meta.controller.js';
import { metaService } from './meta.module.js';

const controller = new MetaController(metaService);

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
metaStoreRouter.post('/install', requireRole('OWNER', 'ADMIN'), controller.startInstall);
metaStoreRouter.post('/configure', requireRole('OWNER', 'ADMIN'), controller.configure);
metaStoreRouter.post(
  '/catalogs/configure',
  requireRole('OWNER', 'ADMIN'),
  controller.configureCatalogs,
);
metaStoreRouter.post('/sync', requireRole('OWNER', 'ADMIN'), controller.sync);
metaStoreRouter.post('/catalogs/sync', requireRole('OWNER', 'ADMIN'), controller.syncCatalogs);
metaStoreRouter.post('/insights/sync', requireRole('OWNER', 'ADMIN'), controller.syncInsights);
