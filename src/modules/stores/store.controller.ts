import type { Request, Response } from 'express';
import type { StoreService } from './store.service.js';

export class StoreController {
  constructor(private readonly service: StoreService) {}

  list = async (req: Request, res: Response) => {
    const stores = await this.service.listForUser(req.context.userId!);
    res.status(200).json({ stores });
  };

  getById = async (req: Request, res: Response) => {
    const store = await this.service.getById(req.context.storeId!);
    res.status(200).json({
      store: {
        ...store,
        role: req.context.role,
      },
    });
  };
}
