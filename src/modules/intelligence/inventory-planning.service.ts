import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export type InventoryPlanningSettings = {
  inventoryRestockLeadTimeDays: number;
  inventoryLowStockThreshold: number;
};

export class InventoryPlanningService {
  async get(storeId: string): Promise<InventoryPlanningSettings> {
    const settings = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        inventoryRestockLeadTimeDays: true,
        inventoryLowStockThreshold: true,
      },
    });
    if (!settings) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return settings;
  }

  async update(
    storeId: string,
    input: InventoryPlanningSettings,
  ): Promise<InventoryPlanningSettings> {
    const existing = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!existing) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    return prisma.store.update({
      where: { id: storeId },
      data: {
        inventoryRestockLeadTimeDays: input.inventoryRestockLeadTimeDays,
        inventoryLowStockThreshold: input.inventoryLowStockThreshold,
        inventoryReviewedAt: new Date(),
      },
      select: {
        inventoryRestockLeadTimeDays: true,
        inventoryLowStockThreshold: true,
      },
    });
  }
}

export const inventoryPlanningService = new InventoryPlanningService();
