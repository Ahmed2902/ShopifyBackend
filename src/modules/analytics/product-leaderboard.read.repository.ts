import { prisma } from '../../lib/prisma.js';

const productIdentitySelect = {
  id: true,
  shopifyProductId: true,
  title: true,
  handle: true,
  productType: true,
  vendor: true,
  status: true,
  tracksInventory: true,
  totalInventory: true,
} as const;

export class ProductLeaderboardReadRepository {
  getCatalogProductCount(storeId: string) {
    return prisma.product.count({
      where: { storeId, deletedAt: null },
    });
  }

  getProductsByIds(storeId: string, productIds: string[]) {
    if (productIds.length === 0) return Promise.resolve([]);
    return prisma.product.findMany({
      where: {
        storeId,
        deletedAt: null,
        id: { in: productIds },
      },
      select: productIdentitySelect,
    });
  }
}
