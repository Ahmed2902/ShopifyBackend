import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import { ShopifyCatalogService } from '../../../src/modules/shopify/catalog/shopify-catalog.service.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shop: 'example-store.myshopify.com',
  accessToken: 'access-token',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  apiVersion: '2026-07',
};

const product = {
  id: 'gid://shopify/Product/1',
  title: 'Black Hoodie',
  handle: 'black-hoodie',
  productType: 'Hoodie',
  vendor: 'Temper',
  tags: ['core'],
  status: 'ACTIVE',
  totalInventory: 10,
  tracksInventory: true,
  publishedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

function variant(id: string) {
  return {
    id,
    title: 'Large',
    displayName: 'Black Hoodie - Large',
    sku: 'HOODIE-L',
    barcode: null,
    price: '50.00',
    compareAtPrice: null,
    position: 1,
    availableForSale: true,
    inventoryQuantity: 10,
    inventoryPolicy: 'DENY',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    selectedOptions: [{ name: 'Size', value: 'L' }],
    product: { id: product.id },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id.endsWith('/2') ? '2' : '1'}`,
      sku: 'HOODIE-L',
      tracked: true,
      requiresShipping: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
  };
}

describe('ShopifyCatalogService webhook reconciliation', () => {
  it('refetches a product and all of its variant pages through focused GraphQL queries', async () => {
    const repository = {
      upsertProduct: vi.fn().mockResolvedValue(undefined),
      upsertVariant: vi.fn().mockResolvedValue(true),
    } as unknown as ShopifyRepository;
    const requestAdminGraphql = vi
      .fn()
      .mockResolvedValueOnce({ product })
      .mockResolvedValueOnce({
        product: {
          variants: {
            nodes: [variant('gid://shopify/ProductVariant/1')],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        },
      })
      .mockResolvedValueOnce({
        product: {
          variants: {
            nodes: [variant('gid://shopify/ProductVariant/2')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    const service = new ShopifyCatalogService(
      repository,
      {} as IntegrationService,
      { requestAdminGraphql } as unknown as ShopifyApiService,
    );

    const result = await service.reconcileProduct(context, product.id);

    expect(result).toEqual({
      found: true,
      variantIds: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
    });
    expect(repository.upsertProduct).toHaveBeenCalledWith(context.storeId, product);
    expect(repository.upsertVariant).toHaveBeenCalledTimes(2);
    expect(requestAdminGraphql).toHaveBeenCalledTimes(3);
    expect(requestAdminGraphql.mock.calls[2]?.[0].variables).toMatchObject({ after: 'cursor-1' });
  });

  it('returns not found without inventing catalog state when Shopify no longer has the product', async () => {
    const repository = {
      upsertProduct: vi.fn(),
      upsertVariant: vi.fn(),
    } as unknown as ShopifyRepository;
    const service = new ShopifyCatalogService(
      repository,
      {} as IntegrationService,
      {
        requestAdminGraphql: vi.fn().mockResolvedValue({ product: null }),
      } as unknown as ShopifyApiService,
    );

    await expect(service.reconcileProduct(context, product.id)).resolves.toEqual({
      found: false,
      variantIds: [],
    });
    expect(repository.upsertProduct).not.toHaveBeenCalled();
  });
});
