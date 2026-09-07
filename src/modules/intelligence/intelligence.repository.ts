import { prisma } from '../../lib/prisma.js';

const SHARED_COLLECTION_MEMBER_LIMIT = 50;

function demandDateWhere(from: Date, to: Date) {
  return {
    OR: [
      { processedAt: { gte: from, lte: to } },
      { processedAt: null, shopifyCreatedAt: { gte: from, lte: to } },
    ],
  };
}

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

  getLatestOrderHistorySync(storeId: string) {
    return prisma.syncRun.findFirst({
      where: {
        provider: 'SHOPIFY',
        resourceType: 'OrdersRefunds',
        status: 'SUCCEEDED',
        shopifyConnection: { is: { storeId } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        recordsRead: true,
        recordsWritten: true,
        finishedAt: true,
      },
    });
  }

  getLatestMetaInsightSyncedAt(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return Promise.resolve(null);
    return prisma.metaInsightDaily.findFirst({
      where: {
        level: 'AD',
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true },
    });
  }

  getMetaEvidenceRows(
    storeId: string,
    selectedAccountIds: string[],
    from: Date,
    to: Date,
  ) {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        date: true,
        syncedAt: true,
        accountCurrency: true,
        spend: true,
        impressions: true,
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
          ...demandDateWhere(from, to),
        },
        productId: { not: null },
      },
      select: {
        productId: true,
        variantId: true,
        quantity: true,
        discountedTotal: true,
        order: {
          select: { shopifyCreatedAt: true, processedAt: true, currencyCode: true },
        },
        product: {
          select: { id: true, shopifyProductId: true, title: true },
        },
        refundLines: {
          select: { quantity: true, subtotal: true, restocked: true },
        },
      },
      orderBy: [
        { order: { processedAt: 'asc' } },
        { order: { shopifyCreatedAt: 'asc' } },
      ],
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

  getActiveProductMappings(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.adProductMapping.findMany({
      where: {
        validUntil: null,
        ad: {
          adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
        },
        product: { storeId, deletedAt: null },
      },
      select: {
        metaAdId: true,
        productId: true,
        variantId: true,
        confidence: true,
        source: true,
        isMerchantConfirmed: true,
        product: {
          select: { id: true, shopifyProductId: true, title: true },
        },
      },
    });
  }

  getSharedExposureTargets(
    storeId: string,
    selectedAccountIds: string[],
    adIds: string[],
  ) {
    const uniqueAdIds = [...new Set(adIds)];
    if (uniqueAdIds.length === 0 || selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.metaAd.findMany({
      where: {
        id: { in: uniqueAdIds },
        deletedAt: null,
        targetScope: { in: ['MULTI_PRODUCT', 'COLLECTION'] },
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        metaAdId: true,
        name: true,
        targetScope: true,
        targetScopeConfidence: true,
        adAccount: { select: { currency: true } },
        productMappings: {
          where: { validUntil: null },
          select: {
            productId: true,
            confidence: true,
            isMerchantConfirmed: true,
            product: {
              select: {
                id: true,
                shopifyProductId: true,
                title: true,
                deletedAt: true,
              },
            },
          },
        },
        collectionMappings: {
          where: { validUntil: null, collection: { deletedAt: null } },
          select: {
            confidence: true,
            isMerchantConfirmed: true,
            collection: {
              select: {
                id: true,
                shopifyCollectionId: true,
                title: true,
                handle: true,
                deletedAt: true,
                _count: { select: { products: true } },
                products: {
                  where: { product: { deletedAt: null } },
                  take: SHARED_COLLECTION_MEMBER_LIMIT,
                  orderBy: [{ position: 'asc' }, { productId: 'asc' }],
                  select: {
                    product: {
                      select: {
                        id: true,
                        shopifyProductId: true,
                        title: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
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
