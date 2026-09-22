import { prisma } from '../../lib/prisma.js';

const SHARED_COLLECTION_MEMBER_LIMIT = 50;

/**
 * Shared-ad targeting evidence from canonical ads/mappings. The returned shape intentionally keeps
 * the current Meta compatibility field names while storage identity is provider-neutral.
 */
export class IntelligenceSharedExposureReadRepository {
  async getTargets(input: {
    storeId: string;
    selectedAccountIds: string[];
    from: Date;
    to: Date;
  }) {
    if (input.selectedAccountIds.length === 0) return [];

    const rows = await prisma.advertisingAd.findMany({
      where: {
        deletedAt: null,
        targetScope: { in: ['MULTI_PRODUCT', 'COLLECTION'] },
        account: {
          storeId: input.storeId,
          provider: 'META',
          providerEntityId: { in: input.selectedAccountIds },
        },
        metrics: {
          some: {
            level: 'AD',
            date: { gte: input.from, lte: input.to },
          },
        },
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        targetScope: true,
        targetScopeConfidence: true,
        account: { select: { currency: true } },
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
      orderBy: [{ providerUpdatedAt: 'desc' }, { name: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      metaAdId: row.providerEntityId,
      name: row.name,
      targetScope: row.targetScope,
      targetScopeConfidence: row.targetScopeConfidence,
      // Meta accounts always carry currency once configured. Keep the established non-null
      // intelligence contract while canonical persistence remains nullable for future providers.
      adAccount: { currency: row.account.currency ?? '' },
      productMappings: row.productMappings,
      collectionMappings: row.collectionMappings,
    }));
  }
}

export const intelligenceSharedExposureReadRepository =
  new IntelligenceSharedExposureReadRepository();
