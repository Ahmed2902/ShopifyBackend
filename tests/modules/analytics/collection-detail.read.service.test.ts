import { beforeEach, describe, expect, it, vi } from 'vitest';

const collection = vi.hoisted(() => ({ findFirst: vi.fn() }));
const productCollection = vi.hoisted(() => ({ count: vi.fn(), findMany: vi.fn() }));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { collection, productCollection },
}));

import { CollectionDetailReadService } from '../../../src/modules/analytics/collection-detail.read.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const collectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('CollectionDetailReadService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collection.findFirst.mockResolvedValue({
      id: collectionId,
      shopifyCollectionId: 'gid://shopify/Collection/1',
      title: 'Fall winners',
      handle: 'fall-winners',
      descriptionHtml: null,
      imageUrl: null,
      sortOrder: 'MANUAL',
      shopifyUpdatedAt: new Date('2026-09-18T12:00:00.000Z'),
    });
    productCollection.count.mockResolvedValue(101);
    productCollection.findMany.mockResolvedValue([
      {
        position: 51,
        product: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          shopifyProductId: 'gid://shopify/Product/51',
          title: 'Page two product',
          handle: 'page-two-product',
          productType: null,
          vendor: null,
          status: 'ACTIVE',
          totalInventory: 3,
          tracksInventory: true,
          publishedAt: null,
        },
      },
    ]);
  });

  it('filters deleted products and returns only the requested membership page', async () => {
    const result = await new CollectionDetailReadService().read(storeId, collectionId, 2, 50);

    const activeMembershipWhere = {
      collectionId,
      product: { deletedAt: null },
    };
    expect(productCollection.count).toHaveBeenCalledWith({ where: activeMembershipWhere });
    expect(productCollection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: activeMembershipWhere,
      skip: 50,
      take: 50,
    }));
    expect(result.collection.productCount).toBe(101);
    expect(result.pagination).toEqual({ page: 2, limit: 50, total: 101, totalPages: 3 });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.title).toBe('Page two product');
  });
});
