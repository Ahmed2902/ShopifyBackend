import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { StoreRepository } from '../stores/store.repository.js';
import { StoreService } from '../stores/store.service.js';
import { IntegrationController } from './integration.controller.js';
import { IntegrationRepository } from './integration.repository.js';
import { IntegrationService } from './integration.service.js';

const storeService = new StoreService(new StoreRepository());
const service = new IntegrationService(new IntegrationRepository(), storeService);
const controller = new IntegrationController(service);

export const integrationRouter = Router({ mergeParams: true });

integrationRouter.use(requireAuth);
integrationRouter.get('/', controller.summary);
integrationRouter.get('/sync-runs', controller.syncRuns);
