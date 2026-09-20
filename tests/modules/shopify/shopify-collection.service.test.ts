import { beforeEach, describe, expect, it, vi } from 'vitest';

const collection = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn() }));
const product = vi.hoisted(() => ({ findMany: vi.fn() }));
const productCollection = vi.hoisted(() => ({ findMany: vi.fn(), createMany: vi.fn() }));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { collection, product, productCollection },
}));
const invalidateStoreDecisionCaches = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../src/lib/store-decision-cache.js', () => ({ invalidateStoreDecisionCaches }));

import { ShopifyCollectionService } from '../../../src/modules/shopify/collection/shopify-collection.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const collectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const productId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function service(scopes: string[]) {
  const repository = {
    findConnectionForSync: vi.fn().mockResolvedValue({
      id: storeId,
      myshopifyDomain: 'stride-test.myshopify.com',
      shopifyConnection: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'ACTIVE',
        scopes,
        apiVersion: '2026-07',
        accessTokenCiphertext: 'cipher',
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        refreshTokenExpiresAt: null,
      },
    }),
  };
  const authService = { resolveAccessToken: vi.fn().mockResolvedValue('token') };
  const apiService = {
    requestAdminGraphql: vi.fn().mockResolvedValue({
      collectionCreate: {
        collection: {
          id: 'gid://shopify/Collection/123',
          title: 'Fall winners',
          handle: 'fall-winners',
          descriptionHtml: '',
          sortOrder: 'MANUAL',
          updatedAt: '2026-09-18T12:00:00.000Z',
          image: null,
        },
        userErrors: [],
      },
    }),
  };
  const catalogRepository = { persistCollections: vi.fn().mockResolvedValue(undefined) };
  return {
    repository,
    authService,
    apiService,
    catalogRepository,
    instance: new ShopifyCollectionService({
      repository: repository as never,
      authService: authService as never,
      apiService: apiService as never,
      catalogRepository: catalogRepository as never,
    }),
  };
}

describe('ShopifyCollectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collection.findUnique.mockResolvedValue({ id: collectionId });
    collection.findFirst.mockResolvedValue({
      id: collectionId,
      shopifyCollectionId: 'gid://shopify/Collection/123',
    });
    product.findMany.mockResolvedValue([
      { id: productId, shopifyProductId: 'gid://shopify/Product/456' },
    ]);
    productCollection.findMany.mockResolvedValue([]);
    productCollection.createMany.mockResolvedValue({ count: 1 });
  });

  it('fails clearly when an existing install has not approved write_products', async () => {
    const subject = service(['read_products']);

    await expect(subject.instance.create(storeId, 'Fall winners')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_COLLECTION_WRITE_SCOPE_REQUIRED',
    });
    expect(subject.apiService.requestAdminGraphql).not.toHaveBeenCalled();
  });

  it('creates in Shopify, persists locally and returns the local collection id for drill-down', async () => {
    const subject = service(['read_products', 'write_products']);

    const result = await subject.instance.create(storeId, 'Fall winners');

    expect(subject.apiService.requestAdminGraphql).toHaveBeenCalledWith(expect.objectContaining({
      shop: 'stride-test.myshopify.com',
      variables: { collection: { title: 'Fall winners' } },
    }));
    expect(subject.catalogRepository.persistCollections).toHaveBeenCalledWith(
      storeId,
      [expect.objectContaining({ id: 'gid://shopify/Collection/123', title: 'Fall winners' })],
    );
    expect(collection.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        storeId_shopifyCollectionId: {
          storeId,
          shopifyCollectionId: 'gid://shopify/Collection/123',
        },
      },
    }));
    expect(result.collection).toEqual({
      id: collectionId,
      shopifyCollectionId: 'gid://shopify/Collection/123',
      title: 'Fall winners',
      handle: 'fall-winners',
    });
  });

  it('adds only new store-owned products to Shopify and persists the membership locally', async () => {
    const subject = service(['read_products', 'write_products']);
    subject.apiService.requestAdminGraphql.mockResolvedValueOnce({
      collectionAddProducts: { userErrors: [] },
    });

    const result = await subject.instance.addProducts(storeId, collectionId, [productId]);

    expect(product.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [productId] }, storeId, deletedAt: null },
    }));
    expect(subject.apiService.requestAdminGraphql).toHaveBeenCalledWith(expect.objectContaining({
      variables: {
        id: 'gid://shopify/Collection/123',
        productIds: ['gid://shopify/Product/456'],
      },
    }));
    expect(productCollection.createMany).toHaveBeenCalledWith({
      data: [{ collectionId, productId }],
      skipDuplicates: true,
    });
    expect(invalidateStoreDecisionCaches).toHaveBeenCalledWith(storeId);
    expect(result).toEqual({ added: 1 });
  });

  it('does not call Shopify when every requested product is already a member', async () => {
    const subject = service(['read_products', 'write_products']);
    productCollection.findMany.mockResolvedValueOnce([{ productId }]);

    await expect(subject.instance.addProducts(storeId, collectionId, [productId])).resolves.toEqual({
      added: 0,
    });

    expect(subject.apiService.requestAdminGraphql).not.toHaveBeenCalled();
    expect(productCollection.createMany).not.toHaveBeenCalled();
  });
});
