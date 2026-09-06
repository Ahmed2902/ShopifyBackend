import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { pixelController } from './pixel.controller.js';

export const pixelPublicRouter = Router();
pixelPublicRouter.post('/events', pixelController.ingest);

export const pixelStoreRouter = Router({ mergeParams: true });
pixelStoreRouter.use(requireAuth, requireStoreMembership);
pixelStoreRouter.get('/status', pixelController.status);
pixelStoreRouter.post('/install', requireRole('OWNER', 'ADMIN'), pixelController.install);
pixelStoreRouter.post(
  '/debug/validate',
  requireRole('OWNER', 'ADMIN'),
  pixelController.debugValidate,
);
