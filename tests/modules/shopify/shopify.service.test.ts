import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const webhookUri = 'http://localhost:3001/v1/integrations/shopify/webhooks';

const shopResponse = {
  data: {
    shop: {
      id: 'gid://shopify/Shop/1',
      name: 'Example Store',
      myshopifyDomain: 'example-store.myshopify.com',
      currencyCode: 'USD',
      ianaTimezone: 'America/New_York',
      primaryDomain: { host: 'example.com', url: 'https://example.com' },
      enabledPresentmentCurrencies: ['USD'],
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  },
};

const productResponse = {
  data: {
    products: {
      nodes: [
        {
          id: 'gid://shopify/Product/1',
          title: 'Black Hoodie',
          handle: 'black-hoodie',
          productType: 'Hoodie',
          vendor: 'Temper',
          tags: ['core'],
          status: 'ACTIVE',
          totalInventory: 62,
          tracksInventory: true,
          publishedAt: '2025-01-02T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: 'product-cursor' },
    },
  },
};

const variantResponse = {
  data: {
    productVariants: {
      nodes: [
        {
          id: 'gid://shopify/ProductVariant/1',
          title: 'Large',
          displayName: 'Black Hoodie - Large',
          sku: 'HOODIE-BLK-L',
          barcode: '123456789',
          price: '59.99',
          compareAtPrice: null,
          position: 1,
          availableForSale: true,
          inventoryQuantity: 62,
          inventoryPolicy: 'DENY',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
          selectedOptions: [{ name: 'Size', value: 'L' }],
          product: { id: 'gid://shopify/Product/1' },
          inventoryItem: {
            id: 'gid://shopify/InventoryItem/1',
            sku: 'HOODIE-BLK-L',
            tracked: true,
            requiresShipping: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
          },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: 'variant-cursor' },
    },
  },
};

const locationResponse = {
  data: {
    locations: {
      nodes: [
        {
          id: 'gid://shopify/Location/1',
          name: 'Main Warehouse',
          isActive: true,
          fulfillsOnlineOrders: true,
          shipsInventory: true,
          hasActiveInventory: true,
          deactivatedAt: null,
          address: { city: 'Cairo', country: 'Egypt', countryCode: 'EG' },
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: 'location-cursor' },
    },
  },
};

const inventoryResponse = {
  data: {
    location: {
      inventoryLevels: {
        nodes: [
          {
            id: 'gid://shopify/InventoryLevel/1',
            updatedAt: '2026-08-19T00:00:00.000Z',
            item: { id: 'gid://shopify/InventoryItem/1' },
            location: { id: 'gid://shopify/Location/1' },
            quantities: [
              { name: 'available', quantity: 62 },
              { name: 'incoming', quantity: 10 },
              { name: 'committed', quantity: 4 },
              { name: 'damaged', quantity: 1 },
              { name: 'on_hand', quantity: 67 },
              { name: 'quality_control', quantity: 0 },
              { name: 'reserved', quantity: 0 },
              { name: 'safety_stock', quantity: 5 },
            ],
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: 'inventory-cursor' },
      },
    },
  },
};

const managedTopics = [
  'APP_UNINSTALLED',
  'BULK_OPERATIONS_FINISH',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'INVENTORY_LEVELS_CONNECT',
  'INVENTORY_LEVELS_UPDATE',
  'INVENTORY_LEVELS_DISCONNECT',
  'LOCATIONS_CREATE',
  'LOCATIONS_UPDATE',
  'LOCATIONS_DELETE',
  'LOCATIONS_ACTIVATE',
  'LOCATIONS_DEACTIVATE',
];

const webhookSubscriptionsResponse = {
  data: {
    webhookSubscriptions: {
      nodes: managedTopics.map((topic, index) => ({
        id: `gid://shopify/WebhookSubscription/${index + 1}`,
        topic,
        uri: webhookUri,
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildService(connectionOverrides: Record<string, unknown> = {}) {
  const repository = {
    findConnectionForSync: vi.fn().mockResolvedValue({
      id: storeId,
      myshopifyDomain: 'example-store.myshopify.com',
      shopifyConnection: {
        id: connectionId,
        status: 'ACTIVE',
        accessTokenCiphertext: encryptSecret('shopify-access-token'),
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        refreshTokenExpiresAt: null,
        scopes: ['read_products', 'read_inventory', 'read_locations'],
        apiVersion: '2026-07',
        lastSyncedAt: null,
        ...connectionOverrides,
      },
    }),
    updateConnectionTokens: vi.fn().mockResolvedValue(undefined),
    updateStoreProfile: vi.fn().mockResolvedValue(undefined),
    upsertProduct: vi.fn().mockResolvedValue(undefined),
    upsertVariant: vi.fn().mockResolvedValue(true),
    upsertLocation: vi.fn().mockResolvedValue(undefined),
    upsertInventoryLevel: vi.fn().mockResolvedValue(true),
    markConnectionSynced: vi.fn().mockResolvedValue(undefined),
    markConnectionReauthRequired: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyRepository;

  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;

  return {
    repository,
    integrationService,
    service: new ShopifyService(repository, integrationService),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shopify catalog and inventory sync', () => {
  it('synchronizes shop, products, variants, locations and all inventory states', async () => {
    const { repository, integrationService, service } = buildService();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(webhookSubscriptionsResponse))
      .mockResolvedValueOnce(jsonResponse(shopResponse))
      .mockResolvedValueOnce(jsonResponse(productResponse))
      .mockResolvedValueOnce(jsonResponse(variantResponse))
      .mockResolvedValueOnce(jsonResponse(locationResponse))
      .mockResolvedValueOnce(jsonResponse(inventoryResponse));
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.syncStoreData(storeId);

    expect(result).toEqual({
      syncRunId,
      status: 'SUCCEEDED',
      resourceType: 'CatalogInventory',
      recordsRead: 5,
      recordsWritten: 5,
      breakdown: {
        shop: 1,
        products: 1,
        variants: 1,
        locations: 1,
        inventoryLevels: 1,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(repository.upsertProduct).toHaveBeenCalledTimes(1);
    expect(repository.upsertVariant).toHaveBeenCalledTimes(1);
    expect(repository.upsertLocation).toHaveBeenCalledTimes(1);
    expect(repository.upsertInventoryLevel).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({ id: 'gid://shopify/InventoryLevel/1' }),
      'INITIAL_SYNC',
    );
    expect(integrationService.startSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'SHOPIFY',
        connectionId,
        resourceType: 'CatalogInventory',
        mode: 'MANUAL',
      }),
    );
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 5,
      recordsWritten: 5,
    });
  });

  it('marks the connection for reauthorization when Shopify rejects the credential during webhook setup', async () => {
    const { repository, integrationService, service } = buildService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(service.syncStoreData(storeId)).rejects.toMatchObject({
      code: 'SHOPIFY_REAUTH_REQUIRED',
    });

    expect(repository.markConnectionReauthRequired).toHaveBeenCalledWith(connectionId);
    expect(integrationService.startSyncRun).not.toHaveBeenCalled();
    expect(integrationService.failSyncRun).not.toHaveBeenCalled();
  });

  it('rotates an expiring offline token before webhook setup and the sync', async () => {
    const { repository, service } = buildService({
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenCiphertext: encryptSecret('shopify-refresh-token'),
      refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const emptyConnection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'rotated-access-token',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-token',
          refresh_token_expires_in: 7_776_000,
          scope: 'read_products,read_inventory,read_locations',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(webhookSubscriptionsResponse))
      .mockResolvedValueOnce(jsonResponse(shopResponse))
      .mockResolvedValueOnce(jsonResponse({ data: { products: emptyConnection } }))
      .mockResolvedValueOnce(jsonResponse({ data: { productVariants: emptyConnection } }))
      .mockResolvedValueOnce(jsonResponse({ data: { locations: emptyConnection } }));
    vi.stubGlobal('fetch', fetchMock);

    await service.syncStoreData(storeId);

    const tokenRequest = fetchMock.mock.calls[0];
    expect(tokenRequest?.[0]).toBe('https://example-store.myshopify.com/admin/oauth/access_token');
    const body = (tokenRequest?.[1] as RequestInit).body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('shopify-refresh-token');
    expect(repository.updateConnectionTokens).toHaveBeenCalledWith(
      connectionId,
      expect.objectContaining({
        accessTokenCiphertext: expect.any(String),
        refreshTokenCiphertext: expect.any(String),
        accessTokenExpiresAt: expect.any(Date),
        refreshTokenExpiresAt: expect.any(Date),
      }),
    );

    const webhookGraphqlHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    const firstSyncGraphqlHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(webhookGraphqlHeaders['X-Shopify-Access-Token']).toBe('rotated-access-token');
    expect(firstSyncGraphqlHeaders['X-Shopify-Access-Token']).toBe('rotated-access-token');
  });
});
