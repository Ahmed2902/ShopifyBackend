import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import { ShopifyInventoryService } from '../../../src/modules/shopify/inventory/shopify-inventory.service.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shop: 'example-store.myshopify.com',
  accessToken: 'access-token',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  apiVersion: '2026-07',
};

const location = {
  id: 'gid://shopify/Location/1',
  name: 'Main Warehouse',
  isActive: true,
  fulfillsOnlineOrders: true,
  shipsInventory: true,
  hasActiveInventory: true,
  deactivatedAt: null,
  address: { city: 'Cairo', country: 'Egypt', countryCode: 'EG' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

const inventoryLevel = {
  id: 'gid://shopify/InventoryLevel/1',
  updatedAt: '2026-08-20T00:00:00.000Z',
  item: { id: 'gid://shopify/InventoryItem/1' },
  location: { id: location.id },
  quantities: [
    { name: 'available', quantity: 8 },
    { name: 'incoming', quantity: 2 },
    { name: 'committed', quantity: 1 },
    { name: 'damaged', quantity: 0 },
    { name: 'on_hand', quantity: 10 },
    { name: 'quality_control', quantity: 0 },
    { name: 'reserved', quantity: 1 },
    { name: 'safety_stock', quantity: 0 },
  ],
};

describe('ShopifyInventoryService webhook reconciliation', () => {
  it('refetches and persists one location from a location webhook', async () => {
    const repository = {
      upsertLocation: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShopifyRepository;
    const service = new ShopifyInventoryService(
      repository,
      {} as IntegrationService,
      {
        requestAdminGraphql: vi.fn().mockResolvedValue({ location }),
      } as unknown as ShopifyApiService,
    );

    await expect(service.reconcileLocation(context, location.id)).resolves.toEqual({ found: true });
    expect(repository.upsertLocation).toHaveBeenCalledWith(context.storeId, location);
  });

  it('returns not found when the location disappeared before the webhook was processed', async () => {
    const repository = { upsertLocation: vi.fn() } as unknown as ShopifyRepository;
    const service = new ShopifyInventoryService(
      repository,
      {} as IntegrationService,
      {
        requestAdminGraphql: vi.fn().mockResolvedValue({ location: null }),
      } as unknown as ShopifyApiService,
    );

    await expect(service.reconcileLocation(context, location.id)).resolves.toEqual({ found: false });
    expect(repository.upsertLocation).not.toHaveBeenCalled();
  });

  it('refetches one exact item/location inventory level and appends a webhook reconciliation snapshot', async () => {
    const repository = {
      upsertInventoryLevel: vi.fn().mockResolvedValue(true),
    } as unknown as ShopifyRepository;
    const service = new ShopifyInventoryService(
      repository,
      {} as IntegrationService,
      {
        requestAdminGraphql: vi.fn().mockResolvedValue({
          inventoryItem: { inventoryLevel },
        }),
      } as unknown as ShopifyApiService,
    );

    await expect(
      service.reconcileInventoryLevel(
        context,
        'gid://shopify/InventoryItem/1',
        'gid://shopify/Location/1',
      ),
    ).resolves.toEqual({ found: true });
    expect(repository.upsertInventoryLevel).toHaveBeenCalledWith(
      context.storeId,
      inventoryLevel,
      'WEBHOOK_RECONCILIATION',
    );
  });

  it('rejects incomplete inventory state instead of silently zeroing a missing Shopify quantity', async () => {
    const repository = {
      upsertInventoryLevel: vi.fn().mockResolvedValue(true),
    } as unknown as ShopifyRepository;
    const service = new ShopifyInventoryService(
      repository,
      {} as IntegrationService,
      {
        requestAdminGraphql: vi.fn().mockResolvedValue({
          inventoryItem: {
            inventoryLevel: {
              ...inventoryLevel,
              quantities: inventoryLevel.quantities.filter((entry) => entry.name !== 'reserved'),
            },
          },
        }),
      } as unknown as ShopifyApiService,
    );

    await expect(
      service.reconcileInventoryLevel(
        context,
        'gid://shopify/InventoryItem/1',
        'gid://shopify/Location/1',
      ),
    ).rejects.toMatchObject({ code: 'SHOPIFY_BAD_RESPONSE' });
    expect(repository.upsertInventoryLevel).not.toHaveBeenCalled();
  });
});
