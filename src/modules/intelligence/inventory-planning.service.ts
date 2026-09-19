import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export class InventoryPlanningService {
  async get(storeId: string) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        inventoryRestockLeadTimeDays: true,
        inventoryLowStockThreshold: true,
        inventoryReviewedAt: true,
      },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return {
      restockLeadTimeDays: store.inventoryRestockLeadTimeDays,
      lowStockThreshold: store.inventoryLowStockThreshold,
      reviewedAt: store.inventoryReviewedAt,
    };
  }

  async update(storeId: string, input: { restockLeadTimeDays: number; lowStockThreshold: number }) {
    try {
      const store = await prisma.store.update({
        where: { id: storeId },
        data: {
          inventoryRestockLeadTimeDays: input.restockLeadTimeDays,
          inventoryLowStockThreshold: input.lowStockThreshold,
          inventoryReviewedAt: new Date(),
        },
        select: {
          inventoryRestockLeadTimeDays: true,
          inventoryLowStockThreshold: true,
          inventoryReviewedAt: true,
        },
      });
      return {
        restockLeadTimeDays: store.inventoryRestockLeadTimeDays,
        lowStockThreshold: store.inventoryLowStockThreshold,
        reviewedAt: store.inventoryReviewedAt,
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
      }
      throw error;
    }
  }
}

export const inventoryPlanningService = new InventoryPlanningService();