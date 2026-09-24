import { prisma } from '../../lib/prisma.js';

export class ProductAdsRepository {
  async getActiveMappings(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return [];

    const rows = await prisma.advertisingProductMapping.findMany({
      where: {
        validUntil: null,
        ad: {
          groupId: { not: null },
          account: {
            storeId,
            provider: 'META',
            providerEntityId: { in: selectedAccountIds },
          },
        },
        product: { storeId },
      },
      select: {
        id: true,
        adId: true,
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
            providerEntityId: true,
            name: true,
            status: true,
            effectiveStatus: true,
            deletedAt: true,
            campaign: {
              select: { id: true, providerEntityId: true, name: true },
            },
            group: {
              select: { id: true, providerEntityId: true, name: true },
            },
            creative: {
              select: {
                id: true,
                providerEntityId: true,
                name: true,
                title: true,
                thumbnailUrl: true,
              },
            },
          },
        },
      },
      orderBy: [{ adId: 'asc' }, { productId: 'asc' }, { variantId: 'asc' }],
    });

    return rows.flatMap((row) =>
      row.ad.group
        ? [{
            id: row.id,
            // Historical API name: this is the local ad UUID, matching AdProductMapping.metaAdId.
            metaAdId: row.adId,
            productId: row.productId,
            variantId: row.variantId,
            source: row.source,
            confidence: row.confidence,
            isMerchantConfirmed: row.isMerchantConfirmed,
            product: row.product,
            variant: row.variant,
            ad: {
              id: row.ad.id,
              metaAdId: row.ad.providerEntityId,
              name: row.ad.name,
              configuredStatus: row.ad.status,
              effectiveStatus: row.ad.effectiveStatus,
              deletedAt: row.ad.deletedAt,
              campaign: {
                id: row.ad.campaign.id,
                metaCampaignId: row.ad.campaign.providerEntityId,
                name: row.ad.campaign.name,
              },
              adSet: {
                id: row.ad.group.id,
                metaAdSetId: row.ad.group.providerEntityId,
                name: row.ad.group.name,
              },
              creative: row.ad.creative
                ? {
                    id: row.ad.creative.id,
                    metaCreativeId: row.ad.creative.providerEntityId,
                    name: row.ad.creative.name,
                    title: row.ad.creative.title,
                    thumbnailUrl: row.ad.creative.thumbnailUrl,
                  }
                : null,
            },
          }]
        : [],
    );
  }
}
