import { Router } from 'express';
import { requireAuth } from '../auth/auth.middleware.js';
import { storeController } from './store.controller.js';

export const storeRouter = Router();

storeRouter.use(requireAuth);
storeRouter.get('/', storeController.list);
storeRouter.get('/:storeId', storeController.getById);
