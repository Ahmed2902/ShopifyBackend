import { prisma } from '../../lib/prisma.js';

const SHARED_COLLECTION_MEMBER_LIMIT = 50;

/**
 * Shared-ad targeting evidence for the intelligence snapshot.
 *
 * This read is deliberately bounded by the same selected Meta accounts and evidence window as
 * `getMetaEvidenceRows`, but it does not depend on that query finishing first. PostgreSQL proves
 * that an ad was observed in the window through the `insights.some` relation, allowing this query
 * to run in parallel with the rest of the snapshot evidence reads.
 */
export class IntelligenceSharedExposureReadRepository {
  getTargets(input: {
    storeId: string;
    selectedAccountIds: string[];
    from: Date;
    to: Date;
  }) {
    if (input.selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.metaAd.findMany({
      where: {
        deletedAt: null,
        targetScope: { in: ['MULTI_PRODUCT', 'COLLECTION'] },
        adAccount: {
          storeId: input.storeId,
          metaAccountId: { in: input.selectedAccountIds },
        },
        insights: {
          some: {
            level: 'AD',
            date: { gte: input.from, lte: input.to },
          },
        },
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
}

export const intelligenceSharedExposureReadRepository =
  new IntelligenceSharedExposureReadRepository();
