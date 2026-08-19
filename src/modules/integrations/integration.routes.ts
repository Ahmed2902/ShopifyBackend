import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { IntegrationController } from './integration.controller.js';
import { IntegrationRepository } from './integration.repository.js';
import { IntegrationService } from './integration.service.js';

const service = new IntegrationService(new IntegrationRepository());
const controller = new IntegrationController(service);

export const integrationRouter = Router({ mergeParams: true });

integrationRouter.use(requireAuth, requireStoreMembership);
integrationRouter.get('/', controller.summary);
integrationRouter.get('/sync-runs', controller.syncRuns);
