import type { Request, Response } from 'express';
import { getAuthUserId } from '../../middleware/auth.middleware.js';
import { storeParamsSchema } from './store.schema.js';
import { StoreService } from './store.service.js';

export class StoreController {
  constructor(private readonly service: StoreService) {}

  list = async (_req: Request, res: Response) => {
    const stores = await this.service.listForUser(getAuthUserId(res));
    res.status(200).json({ stores });
  };

  getById = async (req: Request, res: Response) => {
    const { storeId } = storeParamsSchema.parse(req.params);
    const store = await this.service.getForUser(getAuthUserId(res), storeId);
    res.status(200).json({ store });
  };
}
