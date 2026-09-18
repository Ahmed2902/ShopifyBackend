import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export class CollectionDetailReadService {
  async read(storeId: string, collectionId: string) {
    const collection = await prisma.collection.findFirst({
      where: { id: collectionId, storeId, deletedAt: null },
      select: {
        id: true,
        shopifyCollectionId: true,
        title: true,
        handle: true,
        descriptionHtml: true,
        imageUrl: true,
        sortOrder: true,
        shopifyUpdatedAt: true,
        products: {
          orderBy: [{ position: 'asc' }, { product: { title: 'asc' } }],
          select: {
            position: true,
            product: {
              select: {
                id: true,
                shopifyProductId: true,
                title: true,
                handle: true,
                productType: true,
                vendor: true,
                status: true,
                totalInventory: true,
                tracksInventory: true,
                publishedAt: true,
              },
            },
          },
        },
      },
    });

    if (!collection) {
      throw new AppError('Collection not found', 404, 'COLLECTION_NOT_FOUND');
    }

    return {
      collection: {
        id: collection.id,
        shopifyCollectionId: collection.shopifyCollectionId,
        title: collection.title,
        handle: collection.handle,
        descriptionHtml: collection.descriptionHtml,
        imageUrl: collection.imageUrl,
        sortOrder: collection.sortOrder,
        shopifyUpdatedAt: collection.shopifyUpdatedAt,
        productCount: collection.products.length,
      },
      membershipSnapshot: 'CURRENT' as const,
      products: collection.products.map((membership) => ({
        position: membership.position,
        ...membership.product,
      })),
    };
  }
}

export const collectionDetailReadService = new CollectionDetailReadService();
