import { Router } from 'express';
import { AppError } from '../../errors/app-error.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { StoreRepository } from './store.repository.js';

const repository = new StoreRepository();

export const storeRouter = Router();
storeRouter.use(requireAuth);

storeRouter.get('/', async (req, res) => {
  const stores = await repository.listForUser(req.context.userId!);
  res.status(200).json({
    stores: stores.map(({ memberships, ...store }) => ({
      ...store,
      role: memberships[0]?.role,
    })),
  });
});

storeRouter.get('/:storeId', requireStoreMembership, async (req, res) => {
  const store = await repository.findById(req.context.storeId!);
  if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
  res.status(200).json({ store: { ...store, role: req.context.role } });
});
