import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export class CollectionDetailReadService {
  async read(
    storeId: string,
    collectionId: string,
    page = 1,
    limit = 50,
  ) {
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
      },
    });

    if (!collection) {
      throw new AppError('Collection not found', 404, 'COLLECTION_NOT_FOUND');
    }

    const where = {
      collectionId,
      product: { deletedAt: null },
    };
    const [productCount, memberships] = await Promise.all([
      prisma.productCollection.count({ where }),
      prisma.productCollection.findMany({
        where,
        orderBy: [{ position: 'asc' }, { product: { title: 'asc' } }],
        skip: (page - 1) * limit,
        take: limit,
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
      }),
    ]);

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
        productCount,
      },
      membershipSnapshot: 'CURRENT' as const,
      pagination: {
        page,
        limit,
        total: productCount,
        totalPages: Math.max(1, Math.ceil(productCount / limit)),
      },
      products: memberships.map((membership) => ({
        position: membership.position,
        ...membership.product,
      })),
    };
  }
}

export const collectionDetailReadService = new CollectionDetailReadService();
