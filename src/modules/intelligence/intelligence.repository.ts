import { prisma } from '../../lib/prisma.js';

export class IntelligenceRepository {
  getStoreContext(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        currencyCode: true,
        ianaTimezone: true,
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
        shopifyConnection: {
          select: { status: true, scopes: true, lastSyncedAt: true },
        },
        metaConnection: {
          select: {
            status: true,
            selectedAdAccountIds: true,
          },
        },
      },
    });
  }

  async getMetaEvidenceRows(storeId: string, from: Date, to: Date) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selectedIds = connection?.selectedAdAccountIds ?? [];
    if (selectedIds.length === 0) return [];

    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        adAccount: { storeId, metaAccountId: { in: selectedIds } },
      },
      select: {
        date: true,
        syncedAt: true,
        accountCurrency: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        frequency: true,
        campaign: {
          select: { id: true, metaCampaignId: true, name: true },
        },
        ad: {
          select: {
            id: true,
            metaAdId: true,
            name: true,
            creative: {
              select: { id: true, metaCreativeId: true, name: true, title: true },
            },
          },
        },
        actions: {
          where: {
            kind: { in: ['ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS'] },
          },
          select: { kind: true, actionType: true, actionDestination: true, value: true },
        },
      },
      orderBy: [{ date: 'asc' }, { adId: 'asc' }],
    });
  }

  getCommerceRows(storeId: string, from: Date, to: Date) {
    return prisma.orderLineItem.findMany({
      where: {
        order: {
          storeId,
          isTest: false,
          cancelledAt: null,
          shopifyCreatedAt: { gte: from, lte: to },
        },
        productId: { not: null },
      },
      select: {
        productId: true,
        variantId: true,
        quantity: true,
        discountedTotal: true,
        order: {
          select: { shopifyCreatedAt: true, currencyCode: true },
        },
        product: {
          select: { id: true, shopifyProductId: true, title: true },
        },
        refundLines: {
          select: { quantity: true, subtotal: true, restocked: true },
        },
      },
      orderBy: { order: { shopifyCreatedAt: 'asc' } },
    });
  }

  getVariantCosts(storeId: string, variantIds: string[], from: Date, to: Date) {
    if (variantIds.length === 0) return Promise.resolve([]);
    return prisma.variantCost.findMany({
      where: {
        variantId: { in: variantIds },
        variant: { storeId },
        effectiveFrom: { lte: to },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: from } }],
      },
      select: {
        variantId: true,
        amount: true,
        currency: true,
        effectiveFrom: true,
        effectiveUntil: true,
      },
      orderBy: [{ variantId: 'asc' }, { effectiveFrom: 'asc' }],
    });
  }

  getActiveProductMappings(storeId: string) {
    return prisma.adProductMapping.findMany({
      where: {
        validUntil: null,
        ad: { adAccount: { storeId }, deletedAt: null },
        product: { storeId, deletedAt: null },
      },
      select: {
        metaAdId: true,
        productId: true,
        variantId: true,
        confidence: true,
        source: true,
        isMerchantConfirmed: true,
      },
    });
  }

  getInventoryLevels(storeId: string) {
    return prisma.inventoryLevelCurrent.findMany({
      where: {
        inventoryItem: {
          storeId,
          deletedAt: null,
          variant: { deletedAt: null, product: { deletedAt: null } },
        },
        location: { deletedAt: null, isActive: true },
      },
      select: {
        available: true,
        incoming: true,
        inventoryItem: {
          select: {
            variant: {
              select: { id: true, productId: true },
            },
          },
        },
      },
    });
  }

  getSettings(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
      },
    });
  }

  updateInventoryMode(storeId: string, inventoryIntelligenceMode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE') {
    return prisma.store.update({
      where: { id: storeId },
      data: {
        inventoryIntelligenceMode,
        inventoryReviewedAt: new Date(),
      },
      select: {
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
      },
    });
  }
}
