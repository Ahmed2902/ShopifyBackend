import { describe, expect, it, vi } from 'vitest';
import type { ShopifyReadRepository } from '../../../src/modules/shopify/read/shopify-read.repository.js';
import { ShopifyReadService } from '../../../src/modules/shopify/read/shopify-read.service.js';

function buildService(overrides: Partial<ShopifyReadRepository> = {}) {
  const repository = {
    getStatus: vi.fn().mockResolvedValue({ store: { id: 'store-1' } }),
    listProducts: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 50, total: 0, hasMore: false }),
    getProduct: vi.fn().mockResolvedValue({ id: 'product-1' }),
    listInventory: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 50, total: 0, hasMore: false }),
    listLocations: vi.fn().mockResolvedValue([]),
    listOrders: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 50, total: 0, hasMore: false }),
    getOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
    ...overrides,
  } as unknown as ShopifyReadRepository;

  return { repository, service: new ShopifyReadService(repository) };
}

describe('ShopifyReadService', () => {
  it('delegates product filters with the trusted store boundary', async () => {
    const { repository, service } = buildService();
    const query = { page: 2, limit: 25, q: 'hoodie', status: 'ACTIVE' };

    await service.listProducts('store-a', query);

    expect(repository.listProducts).toHaveBeenCalledWith('store-a', query);
  });

  it('delegates inventory filters with the trusted store boundary', async () => {
    const { repository, service } = buildService();
    const query = { page: 1, limit: 50, lowStockBelow: 5 };

    await service.listInventory('store-a', query);

    expect(repository.listInventory).toHaveBeenCalledWith('store-a', query);
  });

  it('delegates order filters with the trusted store boundary', async () => {
    const { repository, service } = buildService();
    const query = { page: 1, limit: 50, isTest: false };

    await service.listOrders('store-a', query);

    expect(repository.listOrders).toHaveBeenCalledWith('store-a', query);
  });

  it('returns a structured not-found error for an unknown store status', async () => {
    const { service } = buildService({ getStatus: vi.fn().mockResolvedValue(null) } as Partial<ShopifyReadRepository>);

    await expect(service.getStatus('missing-store')).rejects.toMatchObject({
      statusCode: 404,
      code: 'STORE_NOT_FOUND',
    });
  });

  it('returns a structured not-found error for a cross-store or missing product', async () => {
    const { service } = buildService({ getProduct: vi.fn().mockResolvedValue(null) } as Partial<ShopifyReadRepository>);

    await expect(service.getProduct('store-a', 'product-b')).rejects.toMatchObject({
      statusCode: 404,
      code: 'SHOPIFY_PRODUCT_NOT_FOUND',
    });
  });

  it('returns a structured not-found error for a cross-store or missing order', async () => {
    const { service } = buildService({ getOrder: vi.fn().mockResolvedValue(null) } as Partial<ShopifyReadRepository>);

    await expect(service.getOrder('store-a', 'order-b')).rejects.toMatchObject({
      statusCode: 404,
      code: 'SHOPIFY_ORDER_NOT_FOUND',
    });
  });
});
