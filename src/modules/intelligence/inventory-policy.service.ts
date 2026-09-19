import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export type InventoryPolicyInput = {
  mode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE';
  restockLeadDays: number;
  lowStockThreshold: number;
};

const selection = {
  id: true,
  inventoryIntelligenceMode: true,
  inventoryReviewedAt: true,
  inventoryRestockLeadDays: true,
  inventoryLowStockThreshold: true,
} as const;

export class InventoryPolicyService {
  async get(storeId: string) {
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: selection });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return this.serialize(store);
  }

  async update(storeId: string, input: InventoryPolicyInput) {
    const existing = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
    if (!existing) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const store = await prisma.store.update({
      where: { id: storeId },
      data: {
        inventoryIntelligenceMode: input.mode,
        inventoryRestockLeadDays: input.restockLeadDays,
        inventoryLowStockThreshold: input.lowStockThreshold,
        inventoryReviewedAt: new Date(),
      },
      select: selection,
    });
    return this.serialize(store);
  }

  private serialize(store: {
    id: string;
    inventoryIntelligenceMode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE';
    inventoryReviewedAt: Date | null;
    inventoryRestockLeadDays: number;
    inventoryLowStockThreshold: number;
  }) {
    return {
      id: store.id,
      inventoryIntelligenceMode: store.inventoryIntelligenceMode,
      inventoryReviewedAt: store.inventoryReviewedAt,
      restockLeadDays: store.inventoryRestockLeadDays,
      lowStockThreshold: store.inventoryLowStockThreshold,
    };
  }
}

export const inventoryPolicyService = new InventoryPolicyService();
