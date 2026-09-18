import { beforeEach, describe, expect, it, vi } from 'vitest';

const collection = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { collection } }));
vi.mock('../../../src/lib/store-decision-cache.js', () => ({
  invalidateStoreDecisionCaches: vi.fn().mockResolvedValue(undefined),
}));

import { ShopifyCollectionService } from '../../../src/modules/shopify/collection/shopify-collection.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    collection.findUnique.mockResolvedValue({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
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
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      shopifyCollectionId: 'gid://shopify/Collection/123',
      title: 'Fall winners',
      handle: 'fall-winners',
    });
  });
});
