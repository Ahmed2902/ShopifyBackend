import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyCatalogRepository } from '../../../src/modules/shopify/catalog/shopify-catalog.repository.js';
import { ShopifyCatalogService } from '../../../src/modules/shopify/catalog/shopify-catalog.service.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';

const syncContext = {
  storeId: '11111111-1111-4111-8111-111111111111',
  shop: 'example.myshopify.com',
  accessToken: 'token',
  connectionId: '22222222-2222-4222-8222-222222222222',
  apiVersion: '2026-07',
  syncRunId: '33333333-3333-4333-8333-333333333333',
};

function repository() {
  return {
    persistProducts: vi.fn().mockResolvedValue(undefined),
    persistVariants: vi.fn().mockResolvedValue(true),
    persistCollections: vi.fn().mockResolvedValue(undefined),
    replaceCollectionProducts: vi.fn().mockResolvedValue(true),
    markMissingCatalogDeleted: vi.fn().mockResolvedValue(undefined),
    markMissingCollectionsDeleted: vi.fn().mockResolvedValue(undefined),
    enqueuePixelResolutionRepairs: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyCatalogRepository;
}

function integrationService() {
  return {
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;
}

describe('ShopifyCatalogService sync scheduling', () => {
  it('starts variants and collections concurrently after product identities are persisted', async () => {
    let productsPersisted = false;
    let variantsStarted = false;
    let collectionsStarted = false;

    const apiService = {
      requestAdminGraphql: vi.fn().mockImplementation(async ({ query }: { query: string }) => {
        if (query.includes('CatalogProducts')) {
          return {
            products: {
              nodes: [
                {
                  id: 'gid://shopify/Product/1',
                  title: 'Test product',
                  handle: 'test-product',
                  productType: '',
                  vendor: '',
                  tags: [],
                  status: 'ACTIVE',
                  totalInventory: 0,
                  tracksInventory: true,
                  publishedAt: null,
                  createdAt: '2026-09-01T00:00:00.000Z',
                  updatedAt: '2026-09-01T00:00:00.000Z',
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes('CatalogVariants')) {
          expect(productsPersisted).toBe(true);
          variantsStarted = true;
          const deadline = Date.now() + 750;
          while (!collectionsStarted && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return {
            productVariants: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes('CatalogCollections')) {
          expect(productsPersisted).toBe(true);
          collectionsStarted = true;
          return {
            collections: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        throw new Error(`Unexpected query: ${query}`);
      }),
    } as unknown as ShopifyApiService;

    const syncRepository = repository();
    syncRepository.persistProducts = vi.fn().mockImplementation(async () => {
      productsPersisted = true;
    });

    const service = new ShopifyCatalogService(
      {} as ShopifyRepository,
      integrationService(),
      apiService,
      syncRepository,
    );

    const result = await service.sync(syncContext);

    expect(variantsStarted).toBe(true);
    expect(collectionsStarted).toBe(true);
    expect(result.products.written).toBe(1);
    expect(result.variants.written).toBe(0);
    expect(result.collections.written).toBe(0);
  });

  it('waits for the sibling catalog branch to finish before surfacing a failure', async () => {
    let collectionFinished = false;

    const apiService = {
      requestAdminGraphql: vi.fn().mockImplementation(async ({ query }: { query: string }) => {
        if (query.includes('CatalogProducts')) {
          return {
            products: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes('CatalogVariants')) {
          throw new Error('variant sync failed');
        }
        if (query.includes('CatalogCollections')) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          collectionFinished = true;
          return {
            collections: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        throw new Error(`Unexpected query: ${query}`);
      }),
    } as unknown as ShopifyApiService;

    const service = new ShopifyCatalogService(
      {} as ShopifyRepository,
      integrationService(),
      apiService,
      repository(),
    );

    await expect(service.sync(syncContext)).rejects.toThrow('variant sync failed');
    expect(collectionFinished).toBe(true);
  });
});
