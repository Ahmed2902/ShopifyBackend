import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.middleware.js';
import { StoreController } from './store.controller.js';
import { StoreRepository } from './store.repository.js';
import { StoreService } from './store.service.js';

const repository = new StoreRepository();
const service = new StoreService(repository);
const controller = new StoreController(service);

export const storeRouter = Router();

storeRouter.use(requireAuth);
storeRouter.get('/', controller.list);
storeRouter.get('/:storeId', requireRole(), controller.getById);
