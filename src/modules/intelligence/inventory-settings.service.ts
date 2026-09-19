import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export type InventoryPlanningSettingsUpdate = {
  mode?: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE';
  restockLeadTimeDays?: number;
  lowStockThreshold?: number;
};

const selection = {
  inventoryIntelligenceMode: true,
  inventoryRestockLeadDays: true,
  inventoryLowStockThreshold: true,
  inventoryReviewedAt: true,
} as const;

export class InventorySettingsService {
  async read(storeId: string) {
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: selection });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return store;
  }

  async update(storeId: string, input: InventoryPlanningSettingsUpdate) {
    try {
      return await prisma.store.update({
        where: { id: storeId },
        data: {
          ...(input.mode ? { inventoryIntelligenceMode: input.mode } : {}),
          ...(input.restockLeadTimeDays !== undefined
            ? { inventoryRestockLeadDays: input.restockLeadTimeDays }
            : {}),
          ...(input.lowStockThreshold !== undefined
            ? { inventoryLowStockThreshold: input.lowStockThreshold }
            : {}),
          inventoryReviewedAt: new Date(),
        },
        select: selection,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
      }
      throw error;
    }
  }
}

export const inventorySettingsService = new InventorySettingsService();
