import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyCatalogRepository } from '../../../src/modules/shopify/catalog/shopify-catalog.repository.js';
import type { ShopifyInventoryRepository } from '../../../src/modules/shopify/inventory/shopify-inventory.repository.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildService(connectionOverrides: Record<string, unknown> = {}) {
  const repository = {
    connectStore: vi.fn().mockResolvedValue({ id: storeId }),
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
        lastReconciledAt: null,
        nextReconciliationAt: null,
        reconciliationIntervalMinutes: 1440,
        ...connectionOverrides,
      },
    }),
    updateConnectionTokens: vi.fn().mockResolvedValue(undefined),
    updateStoreProfile: vi.fn().mockResolvedValue(undefined),
    upsertProduct: vi.fn().mockResolvedValue(undefined),
    upsertVariant: vi.fn().mockResolvedValue(true),
    upsertLocation: vi.fn().mockResolvedValue(undefined),
    upsertInventoryLevel: vi.fn().mockResolvedValue(true),
    markMissingCatalogDeleted: vi.fn().mockResolvedValue({ products: 0, variants: 0 }),
    markMissingLocationsDeleted: vi.fn().mockResolvedValue(0),
    deleteMissingInventoryLevelsForLocation: vi.fn().mockResolvedValue(0),
    markConnectionSynced: vi.fn().mockResolvedValue(undefined),
    markConnectionReauthRequired: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyRepository;

  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    attachProviderOperation: vi.fn().mockResolvedValue(undefined),
    getLatestShopifySyncRun: vi.fn().mockResolvedValue(null),
    getLastSuccessfulShopifySyncRun: vi.fn().mockResolvedValue(null),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;

  const catalogSyncRepository = {
    persistProducts: vi.fn().mockResolvedValue(undefined),
    persistVariants: vi.fn().mockResolvedValue(true),
  } as unknown as ShopifyCatalogRepository;
  const inventorySyncRepository = {
    persistLocations: vi.fn().mockResolvedValue(undefined),
    persistInventoryLevels: vi.fn().mockResolvedValue(true),
  } as unknown as ShopifyInventoryRepository;

  return {
    repository,
    integrationService,
    catalogSyncRepository,
    inventorySyncRepository,
    service: new ShopifyService(
      repository,
      integrationService,
      undefined,
      undefined,
      catalogSyncRepository,
      inventorySyncRepository,
    ),
  };
}

function stubFullCatalogInventorySync() {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(shopResponse))
    .mockResolvedValueOnce(jsonResponse(productResponse))
    .mockResolvedValueOnce(jsonResponse(variantResponse))
    .mockResolvedValueOnce(jsonResponse(locationResponse))
    .mockResolvedValueOnce(jsonResponse(inventoryResponse));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Shopify catalog and inventory sync', () => {
  it('synchronizes shop, products, variants, locations and all inventory states in batches', async () => {
    const {
      repository,
      integrationService,
      catalogSyncRepository,
      inventorySyncRepository,
      service,
    } = buildService();
    const fetchMock = stubFullCatalogInventorySync();

    const result = await service.syncCatalogAndInventory(storeId);

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
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(catalogSyncRepository.persistProducts).toHaveBeenCalledWith(
      storeId,
      expect.arrayContaining([expect.objectContaining({ id: 'gid://shopify/Product/1' })]),
    );
    expect(catalogSyncRepository.persistVariants).toHaveBeenCalledWith(
      storeId,
      expect.arrayContaining([expect.objectContaining({ id: 'gid://shopify/ProductVariant/1' })]),
    );
    expect(inventorySyncRepository.persistLocations).toHaveBeenCalledWith(
      storeId,
      expect.arrayContaining([expect.objectContaining({ id: 'gid://shopify/Location/1' })]),
    );
    expect(inventorySyncRepository.persistInventoryLevels).toHaveBeenCalledWith(
      storeId,
      expect.arrayContaining([expect.objectContaining({ id: 'gid://shopify/InventoryLevel/1' })]),
      'INITIAL_SYNC',
    );
    expect(repository.markMissingCatalogDeleted).toHaveBeenCalledWith(storeId, [
      'gid://shopify/Product/1',
    ], ['gid://shopify/ProductVariant/1']);
    expect(repository.markMissingLocationsDeleted).toHaveBeenCalledWith(storeId, [
      'gid://shopify/Location/1',
    ]);
    expect(repository.deleteMissingInventoryLevelsForLocation).toHaveBeenCalledWith(
      storeId,
      'gid://shopify/Location/1',
      ['gid://shopify/InventoryItem/1'],
    );
    expect(integrationService.startSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'SHOPIFY',
        connectionId,
        resourceType: 'CatalogInventory',
        mode: 'MANUAL',
      }),
    );
  });

  it('requests Shopify connection pages at the 250-node maximum', async () => {
    const { service } = buildService();
    const fetchMock = stubFullCatalogInventorySync();

    await service.syncCatalogAndInventory(storeId);

    const graphQlBodies = fetchMock.mock.calls
      .map((call) => (call[1] as RequestInit | undefined)?.body)
      .filter((body): body is string => typeof body === 'string')
      .map((body) => JSON.parse(body) as { variables?: { first?: number } });
    const pageSizes = graphQlBodies
      .map((body) => body.variables?.first)
      .filter((value): value is number => typeof value === 'number');

    expect(pageSizes).toEqual([250, 250, 250, 250]);
  });

  it('uses the last successful periodic run as the commerce watermark', async () => {
    const watermark = new Date('2026-08-20T00:00:00.000Z');
    const {
      repository,
      integrationService,
      inventorySyncRepository,
      service,
    } = buildService({
      lastSyncedAt: new Date('2026-08-20T23:00:00.000Z'),
      lastReconciledAt: new Date('2026-08-20T23:00:00.000Z'),
    });
    vi.mocked(integrationService.getLastSuccessfulShopifySyncRun).mockResolvedValue({
      finishedAt: watermark,
    } as never);
    stubFullCatalogInventorySync();

    const result = await service.refreshStoreData(storeId);

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      resourceType: 'StoreReconciliation',
      since: watermark,
      breakdown: {
        products: 1,
        variants: 1,
        inventoryLevels: 1,
        ordersScanned: 0,
        commerceSkipped: true,
      },
    });
    expect(inventorySyncRepository.persistInventoryLevels).toHaveBeenCalledWith(
      storeId,
      expect.anything(),
      'PERIODIC_RECONCILIATION',
    );
    expect(integrationService.getLastSuccessfulShopifySyncRun).toHaveBeenCalledWith(
      connectionId,
      'StoreReconciliation',
    );
    expect(integrationService.startSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'StoreReconciliation', mode: 'PERIODIC' }),
    );
    expect(repository.markConnectionSynced).toHaveBeenCalledWith(connectionId);
  });

  it('marks the connection for reauthorization and fails the sync when Shopify rejects the credential', async () => {
    const { repository, integrationService, service } = buildService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(service.syncCatalogAndInventory(storeId)).rejects.toMatchObject({
      code: 'SHOPIFY_REAUTH_REQUIRED',
    });

    expect(repository.markConnectionReauthRequired).toHaveBeenCalledWith(connectionId);
    expect(integrationService.startSyncRun).toHaveBeenCalledTimes(1);
    expect(integrationService.failSyncRun).toHaveBeenCalledWith(syncRunId, expect.anything());
  });

  it('rotates an expiring offline token before running the sync', async () => {
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
      .mockResolvedValueOnce(jsonResponse(shopResponse))
      .mockResolvedValueOnce(jsonResponse({ data: { products: emptyConnection } }))
      .mockResolvedValueOnce(jsonResponse({ data: { productVariants: emptyConnection } }))
      .mockResolvedValueOnce(jsonResponse({ data: { locations: emptyConnection } }));
    vi.stubGlobal('fetch', fetchMock);

    await service.syncCatalogAndInventory(storeId);

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

    const firstGraphqlHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(firstGraphqlHeaders['X-Shopify-Access-Token']).toBe('rotated-access-token');
  });
});

describe('Shopify OAuth history bootstrap', () => {
  it('starts order history automatically after a new Shopify connection', async () => {
    const { repository, integrationService, service } = buildService({ scopes: ['read_orders'] });
    const oauth = service.beginOAuth('user-1', 'example-store.myshopify.com');
    const state = new URL(oauth.authorizationUrl).searchParams.get('state')!;
    const historySpy = vi.spyOn(service, 'startOrderHistoryBackfill').mockResolvedValue({
      syncRunId,
      status: 'RUNNING',
      resourceType: 'OrdersRefunds',
      providerOperationId: 'bulk-1',
      providerStatus: 'CREATED',
      historyAccess: 'LAST_60_DAYS',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'oauth-access-token',
            expires_in: 3600,
            refresh_token: 'oauth-refresh-token',
            refresh_token_expires_in: 7_776_000,
            scope: 'read_products,read_inventory,read_locations,read_orders',
          }),
        )
        .mockResolvedValueOnce(jsonResponse(shopResponse)),
    );

    await service.completeOAuth({
      code: 'authorization-code',
      shop: 'example-store.myshopify.com',
      state,
      oauthContextCookie: oauth.cookieValue,
    });

    expect(repository.connectStore).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', canonicalDomain: 'example-store.myshopify.com' }),
    );
    expect(integrationService.getLatestShopifySyncRun).toHaveBeenCalledWith(
      storeId,
      'OrdersRefunds',
    );
    expect(historySpy).toHaveBeenCalledWith(storeId);
  });

  it('does not duplicate a history import that is already running', async () => {
    const { integrationService, service } = buildService();
    vi.mocked(integrationService.getLatestShopifySyncRun).mockResolvedValue({
      id: syncRunId,
      status: 'RUNNING',
    } as never);
    const oauth = service.beginOAuth('user-1', 'example-store.myshopify.com');
    const state = new URL(oauth.authorizationUrl).searchParams.get('state')!;
    const historySpy = vi.spyOn(service, 'startOrderHistoryBackfill');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'oauth-access-token',
            expires_in: 3600,
            refresh_token: 'oauth-refresh-token',
            refresh_token_expires_in: 7_776_000,
            scope: 'read_products,read_inventory,read_locations,read_orders',
          }),
        )
        .mockResolvedValueOnce(jsonResponse(shopResponse)),
    );

    await service.completeOAuth({
      code: 'authorization-code',
      shop: 'example-store.myshopify.com',
      state,
      oauthContextCookie: oauth.cookieValue,
    });

    expect(historySpy).not.toHaveBeenCalled();
  });
});
