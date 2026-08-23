import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { IntegrationController } from './integration.controller.js';
import { integrationService } from './integration.service.js';

const controller = new IntegrationController(integrationService);

export const integrationRouter = Router({ mergeParams: true });
integrationRouter.use(requireAuth, requireStoreMembership);
integrationRouter.get('/', controller.summary);
integrationRouter.get('/sync-runs', controller.syncRuns);
