import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthUserId } from '../auth/auth.middleware.js';
import { getStoreForUser, listStoresForUser } from './store.service.js';

const storeIdSchema = z.string().uuid();

export const storeController = {
  async list(_req: Request, res: Response) {
    const stores = await listStoresForUser(getAuthUserId(res));
    res.status(200).json({ stores });
  },

  async getById(req: Request, res: Response) {
    const storeId = storeIdSchema.parse(req.params.storeId);
    const store = await getStoreForUser(getAuthUserId(res), storeId);
    res.status(200).json({ store });
  },
};
