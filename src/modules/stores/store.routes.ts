import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { StoreController } from './store.controller.js';
import { StoreRepository } from './store.repository.js';
import { StoreService } from './store.service.js';

const controller = new StoreController(new StoreService(new StoreRepository()));

export const storeRouter = Router();
storeRouter.use(requireAuth);
storeRouter.get('/', controller.list);
storeRouter.get('/:storeId', requireStoreMembership, controller.getById);
