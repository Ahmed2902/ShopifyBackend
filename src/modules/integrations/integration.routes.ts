import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { integrationController } from './integration.controller.js';

export const integrationRouter = Router({ mergeParams: true });
integrationRouter.use(requireAuth, requireStoreMembership);
integrationRouter.get('/', integrationController.summary);
integrationRouter.get('/sync-runs', integrationController.syncRuns);
