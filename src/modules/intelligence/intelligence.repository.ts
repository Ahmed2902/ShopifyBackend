import { prisma } from '../../lib/prisma.js';

export class IntelligenceRepository {
  findStoreState(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        currencyCode: true,
        ianaTimezone: true,
        shopifyConnection: {
          select: { status: true, lastSyncedAt: true, lastReconciledAt: true },
        },
        metaConnection: {
          select: { status: true, selectedAdAccountIds: true, lastSyncedAt: true },
        },
        tiktokConnection: {
          select: { status: true, selectedAdvertiserIds: true, lastSyncedAt: true },
        },
      },
    });
  }

  listProducts(storeId: string) {
    return prisma.product.findMany({
      where: { storeId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        tracksInventory: true,
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            inventoryQuantity: true,
            inventoryItem: {
              select: {
                currentLevels: {
                  select: { available: true, incoming: true },
                },
              },
            },
          },
        },
      },
      orderBy: { title: 'asc' },
    });
  }

  listOrdersSince(storeId: string, from: Date) {
    return prisma.order.findMany({
      where: {
        storeId,
        isTest: false,
        cancelledAt: null,
        shopifyCreatedAt: { gte: from },
      },
      select: {
        id: true,
        shopifyCreatedAt: true,
        currentTotalAmount: true,
        currencyCode: true,
        lineItems: {
          select: {
            productId: true,
            variantId: true,
            quantity: true,
            currentQuantity: true,
            discountedTotal: true,
            originalTotal: true,
            refundLines: {
              select: { quantity: true, subtotal: true },
            },
          },
        },
        refunds: { select: { totalRefunded: true } },
      },
      orderBy: { shopifyCreatedAt: 'asc' },
    });
  }

  listMetaCampaigns(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return [];
    return prisma.metaCampaign.findMany({
      where: {
        deletedAt: null,
        adAccount: {
          storeId,
          metaAccountId: { in: selectedAccountIds },
        },
      },
      select: {
        id: true,
        metaCampaignId: true,
        name: true,
        effectiveStatus: true,
        status: true,
        objective: true,
        metaCreatedAt: true,
        adAccount: { select: { metaAccountId: true, currency: true } },
        adSets: {
          where: { deletedAt: null },
          select: {
            optimizationGoal: true,
            destinationType: true,
            promotedObject: true,
          },
          take: 5,
        },
      },
    });
  }

  listMetaInsights(storeId: string, selectedAccountIds: string[], from: Date) {
    if (selectedAccountIds.length === 0) return [];
    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from },
        adId: { not: null },
        adAccount: {
          storeId,
          metaAccountId: { in: selectedAccountIds },
        },
      },
      select: {
        date: true,
        campaignId: true,
        adId: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        outboundClicks: true,
        frequency: true,
        actions: {
          where: {
            kind: { in: ['CONVERSION', 'CONVERSION_VALUE'] },
          },
          select: { kind: true, actionType: true, value: true },
        },
      },
      orderBy: { date: 'asc' },
    });
  }

  listTikTokCampaigns(storeId: string, selectedAdvertiserIds: string[]) {
    if (selectedAdvertiserIds.length === 0) return [];
    return prisma.tikTokCampaign.findMany({
      where: {
        deletedAt: null,
        advertiser: {
          storeId,
          advertiserId: { in: selectedAdvertiserIds },
        },
      },
      select: {
        id: true,
        tiktokCampaignId: true,
        name: true,
        objectiveType: true,
        campaignType: true,
        operationStatus: true,
        tiktokCreatedAt: true,
        advertiser: { select: { advertiserId: true, currency: true } },
        adGroups: {
          where: { deletedAt: null },
          select: {
            optimizationGoal: true,
            catalogId: true,
            productSetId: true,
          },
          take: 5,
        },
      },
    });
  }

  listTikTokInsights(storeId: string, selectedAdvertiserIds: string[], from: Date) {
    if (selectedAdvertiserIds.length === 0) return [];
    return prisma.tikTokInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from },
        adId: { not: null },
        advertiser: {
          storeId,
          advertiserId: { in: selectedAdvertiserIds },
        },
      },
      select: {
        date: true,
        campaignId: true,
        adId: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        frequency: true,
        conversions: true,
        conversionValue: true,
      },
      orderBy: { date: 'asc' },
    });
  }

  listMetaAdMappings(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return [];
    return prisma.metaAd.findMany({
      where: {
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        campaignId: true,
        targetScope: true,
        targetScopeConfidence: true,
        productMappings: {
          where: { validUntil: null },
          select: {
            productId: true,
            confidence: true,
            isMerchantConfirmed: true,
          },
        },
      },
    });
  }

  listTikTokAdMappings(storeId: string, selectedAdvertiserIds: string[]) {
    if (selectedAdvertiserIds.length === 0) return [];
    return prisma.tikTokAd.findMany({
      where: {
        deletedAt: null,
        advertiser: { storeId, advertiserId: { in: selectedAdvertiserIds } },
      },
      select: {
        id: true,
        campaignId: true,
        targetScope: true,
        targetScopeConfidence: true,
        productMappings: {
          where: { validUntil: null },
          select: {
            productId: true,
            confidence: true,
            isMerchantConfirmed: true,
          },
        },
      },
    });
  }
}
