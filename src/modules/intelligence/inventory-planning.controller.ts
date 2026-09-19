import type { Request, Response } from 'express';
import { z } from 'zod';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { inventoryPlanningService } from './inventory-planning.service.js';

const inventoryPlanningUpdateSchema = z.object({
  restockLeadTimeDays: z.number().int().min(0).max(365),
  lowStockThreshold: z.number().int().min(0).max(1_000_000),
});

export class InventoryPlanningController {
  read = async (req: Request, res: Response) => {
    res.status(200).json(await inventoryPlanningService.get(req.context.storeId!));
  };

  update = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const input = inventoryPlanningUpdateSchema.parse(req.body);
    const result = await inventoryPlanningService.update(storeId, {
      inventoryRestockLeadTimeDays: input.restockLeadTimeDays,
      inventoryLowStockThreshold: input.lowStockThreshold,
    });
    await invalidateStoreDecisionCaches(storeId);
    res.status(200).json(result);
  };
}

export const inventoryPlanningController = new InventoryPlanningController();
