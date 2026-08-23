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
metaStoreRouter.post('/install', requireRole('OWNER', 'ADMIN'), controller.startInstall);
metaStoreRouter.post('/configure', requireRole('OWNER', 'ADMIN'), controller.configure);
