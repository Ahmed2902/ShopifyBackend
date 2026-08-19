import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.middleware.js';
import { IntegrationController } from './integration.controller.js';
import { IntegrationRepository } from './integration.repository.js';
import { IntegrationService } from './integration.service.js';

const service = new IntegrationService(new IntegrationRepository());
const controller = new IntegrationController(service);
const READ_ROLES = ['OWNER', 'ADMIN', 'MEMBER'];

export const integrationRouter = Router({ mergeParams: true });

integrationRouter.use(requireAuth);
integrationRouter.use(requireRole(READ_ROLES));
integrationRouter.get('/', controller.summary);
integrationRouter.get('/sync-runs', controller.syncRuns);
