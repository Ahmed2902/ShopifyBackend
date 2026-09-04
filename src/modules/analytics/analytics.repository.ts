import { prisma } from '../../lib/prisma.js';

interface MetaEvidenceFilter {
  campaignIds?: string[];
  adSetIds?: string[];
  adIds?: string[];
  creativeIds?: string[];
}

function demandDateWhere(from: Date, to: Date) {
  return {
    OR: [
      { processedAt: { gte: from, lte: to } },
      { processedAt: null, shopifyCreatedAt: { gte: from, lte: to } },
    ],
  };
}

export class AnalyticsRepository {
  getStoreContext(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        currencyCode: true,
        ianaTimezone: true,
        inventoryIntelligenceMode: true,
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

  getOrders(storeId: string, from: Date, to: Date) {
    return prisma.order.findMany({
      where: {
        storeId,
        isTest: false,
        cancelledAt: null,
        ...demandDateWhere(from, to),
      },
      select: {
        id: true,
        shopifyCreatedAt: true,
        processedAt: true,
        currencyCode: true,
        currentSubtotalLineItemsQuantity: true,
        currentTotalAmount: true,
        currentTotalDiscountsAmount: true,
        customerOrderIndex: true,
        customerJourneyReady: true,
        refunds: {
          select: {
            totalRefunded: true,
            currencyCode: true,
          },
        },
      },
    });
  }

  getCommerceRows(storeId: string, from: Date, to: Date, productIds?: string[]) {
    return prisma.orderLineItem.findMany({
      where: {
        ...(productIds ? { productId: { in: productIds } } : { productId: { not: null } }),
        order: {
          storeId,
          isTest: false,
          cancelledAt: null,
          ...demandDateWhere(from, to),
        },
      },
      select: {
        productId: true,
        variantId: true,
        quantity: true,
        currentQuantity: true,
        discountedTotal: true,
        order: {
          select: {
            id: true,
            shopifyCreatedAt: true,
            processedAt: true,
            currencyCode: true,
          },
        },
        product: {
          select: {
            id: true,
            shopifyProductId: true,
            title: true,
            productType: true,
            vendor: true,
            status: true,
          },
        },
        variant: {
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            sku: true,
          },
        },
        refundLines: {
          select: {
            quantity: true,
            subtotal: true,
            restocked: true,
          },
        },
      },
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

  async getProductsPage(storeId: string, page: number, limit: number) {
    const where = { storeId, deletedAt: null };
    const [total, items] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ status: 'asc' }, { title: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          shopifyProductId: true,
          title: true,
          handle: true,
          productType: true,
          vendor: true,
          status: true,
          tracksInventory: true,
          totalInventory: true,
        },
      }),
    ]);
    return { total, items };
  }

  getProduct(storeId: string, productId: string) {
    return prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: {
        id: true,
        shopifyProductId: true,
        title: true,
        handle: true,
        productType: true,
        vendor: true,
        status: true,
        tags: true,
        tracksInventory: true,
        totalInventory: true,
        variants: {
          where: { deletedAt: null },
          orderBy: [{ position: 'asc' }, { title: 'asc' }],
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            displayName: true,
            sku: true,
            price: true,
            compareAtPrice: true,
            availableForSale: true,
            inventoryQuantity: true,
          },
        },
        collections: {
          select: {
            collection: { select: { id: true, title: true, handle: true } },
          },
        },
      },
    });
  }

  async getCollectionsPage(storeId: string, page: number, limit: number) {
    const where = { storeId, deletedAt: null };
    const [total, items] = await Promise.all([
      prisma.collection.count({ where }),
      prisma.collection.findMany({
        where,
        orderBy: { title: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          shopifyCollectionId: true,
          title: true,
          handle: true,
          imageUrl: true,
          products: { select: { productId: true } },
        },
      }),
    ]);
    return { total, items };
  }

  async getInventoryPage(storeId: string, page: number, limit: number) {
    const where = {
      storeId,
      deletedAt: null,
      variant: { deletedAt: null, product: { deletedAt: null } },
    };
    const [total, items] = await Promise.all([
      prisma.inventoryItem.count({ where }),
      prisma.inventoryItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          tracked: true,
          sku: true,
          variant: {
            select: {
              id: true,
              shopifyVariantId: true,
              title: true,
              displayName: true,
              productId: true,
              product: { select: { id: true, shopifyProductId: true, title: true } },
            },
          },
          currentLevels: {
            where: { location: { deletedAt: null, isActive: true } },
            select: {
              available: true,
              incoming: true,
              committed: true,
              onHand: true,
              location: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);
    return { total, items };
  }

  getVariantSalesRows(storeId: string, variantIds: string[], from: Date, to: Date) {
    if (variantIds.length === 0) return Promise.resolve([]);
    return prisma.orderLineItem.findMany({
      where: {
        variantId: { in: variantIds },
        order: {
          storeId,
          isTest: false,
          cancelledAt: null,
          ...demandDateWhere(from, to),
        },
      },
      select: {
        variantId: true,
        quantity: true,
        refundLines: { select: { quantity: true, restocked: true } },
      },
    });
  }

  getMetaRows(
    storeId: string,
    selectedAccountIds: string[],
    from: Date,
    to: Date,
    filter: MetaEvidenceFilter = {},
  ) {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);
    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
        ...(filter.campaignIds ? { campaignId: { in: filter.campaignIds } } : {}),
        ...(filter.adSetIds ? { adSetId: { in: filter.adSetIds } } : {}),
        ...(filter.adIds ? { adId: { in: filter.adIds } } : {}),
        ...(filter.creativeIds
          ? { ad: { creativeId: { in: filter.creativeIds }, deletedAt: null } }
          : {}),
      },
      select: {
        date: true,
        accountCurrency: true,
        spend: true,
        impressions: true,
        clicks: true,
        frequency: true,
        objective: true,
        optimizationGoal: true,
        attributionSetting: true,
        syncedAt: true,
        campaign: {
          select: {
            id: true,
            metaCampaignId: true,
            name: true,
          },
        },
        adSet: {
          select: {
            id: true,
            metaAdSetId: true,
            name: true,
          },
        },
        ad: {
          select: {
            id: true,
            metaAdId: true,
            name: true,
            creative: {
              select: {
                id: true,
                metaCreativeId: true,
                name: true,
                title: true,
              },
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

  async getCampaignsPage(storeId: string, selectedAccountIds: string[], page: number, limit: number) {
    const where = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
    };
    const [total, items] = await Promise.all([
      prisma.metaCampaign.count({ where }),
      prisma.metaCampaign.findMany({
        where,
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          metaCampaignId: true,
          name: true,
          effectiveStatus: true,
          configuredStatus: true,
          objective: true,
          buyingType: true,
          bidStrategy: true,
          dailyBudgetMinor: true,
          lifetimeBudgetMinor: true,
          budgetRemainingMinor: true,
          startTime: true,
          stopTime: true,
        },
      }),
    ]);
    return { total, items };
  }

  getCampaign(storeId: string, selectedAccountIds: string[], campaignId: string) {
    return prisma.metaCampaign.findFirst({
      where: {
        id: campaignId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        metaCampaignId: true,
        name: true,
        effectiveStatus: true,
        configuredStatus: true,
        objective: true,
        buyingType: true,
        bidStrategy: true,
        dailyBudgetMinor: true,
        lifetimeBudgetMinor: true,
        budgetRemainingMinor: true,
        startTime: true,
        stopTime: true,
      },
    });
  }

  async getAdSetsPage(storeId: string, selectedAccountIds: string[], page: number, limit: number) {
    const where = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
    };
    const [total, items] = await Promise.all([
      prisma.metaAdSet.count({ where }),
      prisma.metaAdSet.findMany({
        where,
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          metaAdSetId: true,
          name: true,
          effectiveStatus: true,
          configuredStatus: true,
          optimizationGoal: true,
          billingEvent: true,
          bidStrategy: true,
          bidAmountMinor: true,
          dailyBudgetMinor: true,
          lifetimeBudgetMinor: true,
          budgetRemainingMinor: true,
          startTime: true,
          endTime: true,
          campaign: { select: { id: true, name: true, metaCampaignId: true } },
        },
      }),
    ]);
    return { total, items };
  }

  getAdSet(storeId: string, selectedAccountIds: string[], adSetId: string) {
    return prisma.metaAdSet.findFirst({
      where: {
        id: adSetId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        metaAdSetId: true,
        name: true,
        effectiveStatus: true,
        configuredStatus: true,
        optimizationGoal: true,
        billingEvent: true,
        bidStrategy: true,
        bidAmountMinor: true,
        dailyBudgetMinor: true,
        lifetimeBudgetMinor: true,
        budgetRemainingMinor: true,
        targeting: true,
        attributionSpec: true,
        startTime: true,
        endTime: true,
        campaign: { select: { id: true, name: true, metaCampaignId: true } },
      },
    });
  }

  async getAdsPage(storeId: string, selectedAccountIds: string[], page: number, limit: number) {
    const where = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
    };
    const [total, items] = await Promise.all([
      prisma.metaAd.count({ where }),
      prisma.metaAd.findMany({
        where,
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          metaAdId: true,
          name: true,
          effectiveStatus: true,
          configuredStatus: true,
          campaign: { select: { id: true, name: true, metaCampaignId: true } },
          adSet: { select: { id: true, name: true, metaAdSetId: true } },
          creative: {
            select: { id: true, metaCreativeId: true, name: true, title: true, thumbnailUrl: true },
          },
        },
      }),
    ]);
    return { total, items };
  }

  getAd(storeId: string, selectedAccountIds: string[], adId: string) {
    return prisma.metaAd.findFirst({
      where: {
        id: adId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        metaAdId: true,
        name: true,
        effectiveStatus: true,
        configuredStatus: true,
        conversionDomain: true,
        targetScope: true,
        targetScopeConfidence: true,
        campaign: { select: { id: true, name: true, metaCampaignId: true } },
        adSet: { select: { id: true, name: true, metaAdSetId: true } },
        creative: {
          select: {
            id: true,
            metaCreativeId: true,
            name: true,
            title: true,
            body: true,
            callToActionType: true,
            imageUrl: true,
            thumbnailUrl: true,
            videoId: true,
            linkUrl: true,
            instagramPermalinkUrl: true,
          },
        },
      },
    });
  }

  async getCreativesPage(storeId: string, selectedAccountIds: string[], page: number, limit: number) {
    const where = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
    };
    const [total, items] = await Promise.all([
      prisma.metaCreative.count({ where }),
      prisma.metaCreative.findMany({
        where,
        orderBy: [{ metaUpdatedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          metaCreativeId: true,
          name: true,
          title: true,
          body: true,
          callToActionType: true,
          imageUrl: true,
          thumbnailUrl: true,
          videoId: true,
          linkUrl: true,
        },
      }),
    ]);
    return { total, items };
  }

  getCreative(storeId: string, selectedAccountIds: string[], creativeId: string) {
    return prisma.metaCreative.findFirst({
      where: {
        id: creativeId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        metaCreativeId: true,
        name: true,
        title: true,
        body: true,
        callToActionType: true,
        imageUrl: true,
        thumbnailUrl: true,
        videoId: true,
        linkUrl: true,
        instagramPermalinkUrl: true,
        urlTags: true,
      },
    });
  }
}
