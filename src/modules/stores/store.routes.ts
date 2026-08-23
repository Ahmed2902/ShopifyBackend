import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { storeController } from './store.controller.js';

export const storeRouter = Router();
storeRouter.use(requireAuth);
storeRouter.get('/', storeController.list);
storeRouter.get('/:storeId', requireStoreMembership, storeController.getById);
