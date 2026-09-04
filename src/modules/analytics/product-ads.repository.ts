import { prisma } from '../../lib/prisma.js';

export class ProductAdsRepository {
  getActiveMappings(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.adProductMapping.findMany({
      where: {
        validUntil: null,
        ad: {
          adAccount: {
            storeId,
            metaAccountId: { in: selectedAccountIds },
          },
        },
        product: {
          storeId,
        },
      },
      select: {
        id: true,
        metaAdId: true,
        productId: true,
        variantId: true,
        source: true,
        confidence: true,
        isMerchantConfirmed: true,
        product: {
          select: {
            id: true,
            shopifyProductId: true,
            title: true,
            status: true,
            deletedAt: true,
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
        ad: {
          select: {
            id: true,
            metaAdId: true,
            name: true,
            configuredStatus: true,
            effectiveStatus: true,
            deletedAt: true,
            campaign: {
              select: { id: true, metaCampaignId: true, name: true },
            },
            adSet: {
              select: { id: true, metaAdSetId: true, name: true },
            },
            creative: {
              select: {
                id: true,
                metaCreativeId: true,
                name: true,
                title: true,
                thumbnailUrl: true,
              },
            },
          },
        },
      },
      orderBy: [{ metaAdId: 'asc' }, { productId: 'asc' }, { variantId: 'asc' }],
    });
  }
}
