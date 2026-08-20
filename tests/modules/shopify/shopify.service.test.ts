import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function buildService() {
  const repository = {
    findConnectionForSync: vi.fn().mockResolvedValue({
      id: storeId,
      myshopifyDomain: 'example-store.myshopify.com',
      shopifyConnection: {
        id: connectionId,
        status: 'ACTIVE',
        accessTokenCiphertext: encryptSecret('shopify-access-token'),
        apiVersion: '2026-07',
      },
    }),
    updateStoreProfile: vi.fn().mockResolvedValue(undefined),
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

describe('Shopify sync service', () => {
  it('runs a store-scoped Shopify sync through the shared SyncRun lifecycle', async () => {
    const { repository, integrationService, service } = buildService();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            shop: {
              id: 'gid://shopify/Shop/1',
              name: 'Example Store',
              myshopifyDomain: 'example-store.myshopify.com',
              currencyCode: 'USD',
              ianaTimezone: 'America/New_York',
              primaryDomain: {
                host: 'example.com',
                url: 'https://example.com',
              },
              enabledPresentmentCurrencies: ['USD'],
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
          extensions: {
            cost: {
              requestedQueryCost: 1,
              actualQueryCost: 1,
              throttleStatus: {
                maximumAvailable: 1000,
                currentlyAvailable: 999,
                restoreRate: 50,
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.syncShopProfile(storeId);

    expect(result).toMatchObject({
      syncRunId,
      status: 'SUCCEEDED',
      recordsRead: 1,
      recordsWritten: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example-store.myshopify.com/admin/api/2026-07/graphql.json',
    );
    expect(repository.updateStoreProfile).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({ id: 'gid://shopify/Shop/1' }),
    );
    expect(integrationService.startSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'SHOPIFY',
        connectionId,
        resourceType: 'Shop',
        mode: 'MANUAL',
      }),
    );
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 1,
      recordsWritten: 1,
    });
  });

  it('marks the connection for reauthorization when Shopify rejects the credential', async () => {
    const { repository, integrationService, service } = buildService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(service.syncShopProfile(storeId)).rejects.toMatchObject({
      code: 'SHOPIFY_REAUTH_REQUIRED',
    });

    expect(repository.markConnectionReauthRequired).toHaveBeenCalledWith(connectionId);
    expect(integrationService.failSyncRun).toHaveBeenCalledWith(syncRunId, expect.anything());
  });
});
