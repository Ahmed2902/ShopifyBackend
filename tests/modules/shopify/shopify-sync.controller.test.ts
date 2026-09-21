import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ShopifyController } from '../../../src/modules/shopify/shopify.controller.js';
import type { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const syncRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe('ShopifyController manual sync', () => {
  it('returns 202 after enqueueing instead of executing the full provider sync in the request', async () => {
    const service = {
      enqueueCatalogAndInventorySync: vi.fn().mockResolvedValue({
        syncRunId,
        status: 'PENDING',
        resourceType: 'CatalogInventory',
        deduplicated: false,
      }),
      syncCatalogAndInventory: vi.fn(),
    } as unknown as ShopifyService;
    const controller = new ShopifyController(service);
    const req = { context: { storeId } } as unknown as Request;
    const res = response();

    await controller.sync(req, res);

    expect(service.enqueueCatalogAndInventorySync).toHaveBeenCalledWith(storeId);
    expect(service.syncCatalogAndInventory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      syncRunId,
      status: 'PENDING',
      resourceType: 'CatalogInventory',
      deduplicated: false,
    });
  });
});
