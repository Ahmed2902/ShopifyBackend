import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyOrderRepository } from '../../../src/modules/shopify/order/shopify-order.repository.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const operationId = 'gid://shopify/BulkOperation/1';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubBulkStart() {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: { id: operationId, status: 'CREATED' },
          userErrors: [],
        },
      },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function buildService(scopes = ['read_products', 'read_inventory', 'read_locations', 'read_orders']) {
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
        scopes,
        apiVersion: '2026-07',
        lastSyncedAt: null,
      },
    }),
    markConnectionReauthRequired: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyRepository;

  const orderRepository = {
    upsertOrderWithLineItems: vi.fn(),
    upsertRefundWithLineItems: vi.fn(),
  } as unknown as ShopifyOrderRepository;

  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    attachProviderOperation: vi.fn().mockResolvedValue(undefined),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
    getShopifySyncRun: vi.fn().mockResolvedValue({
      id: syncRunId,
      status: 'RUNNING',
      providerOperationId: operationId,
      recordsRead: 0,
      recordsWritten: 0,
      lastError: null,
      finishedAt: null,
      apiVersion: '2026-07',
      shopifyConnectionId: connectionId,
    }),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;

  return {
    repository,
    integrationService,
    service: new ShopifyService(repository, integrationService, orderRepository),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shopify order-history facade', () => {
  it('starts order history as one asynchronous Shopify bulk operation', async () => {
    const { integrationService, service } = buildService();
    const fetchMock = stubBulkStart();

    const result = await service.startOrderHistoryBackfill(storeId);

    expect(result).toEqual({
      syncRunId,
      status: 'RUNNING',
      resourceType: 'OrdersRefunds',
      providerOperationId: operationId,
      providerStatus: 'CREATED',
      historyAccess: 'LAST_60_DAYS',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(integrationService.startSyncRun).toHaveBeenCalledWith({
      provider: 'SHOPIFY',
      connectionId,
      resourceType: 'OrdersRefunds',
      mode: 'BACKFILL',
      apiVersion: '2026-07',
    });
    expect(integrationService.attachProviderOperation).toHaveBeenCalledWith(syncRunId, operationId);
  });

  it('does not start a backfill when the connection lacks order scope', async () => {
    const { integrationService, service } = buildService(['read_products']);

    await expect(service.startOrderHistoryBackfill(storeId)).rejects.toMatchObject({
      code: 'SHOPIFY_ORDER_SCOPE_REQUIRED',
    });
    expect(integrationService.startSyncRun).not.toHaveBeenCalled();
  });

  it('reports full order-history access when read_all_orders is granted', async () => {
    const { service } = buildService(['read_orders', 'read_all_orders']);
    stubBulkStart();

    const result = await service.startOrderHistoryBackfill(storeId);

    expect(result.historyAccess).toBe('ALL_ORDERS');
  });

  it('polls the provider operation without importing while Shopify is still running', async () => {
    const { integrationService, service } = buildService();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            bulkOperation: {
              id: operationId,
              status: 'RUNNING',
              errorCode: null,
              objectCount: '120',
              url: null,
              partialDataUrl: null,
            },
          },
        }),
      ),
    );

    const result = await service.getOrderHistoryBackfill(storeId, syncRunId);

    expect(result).toEqual({
      syncRunId,
      status: 'RUNNING',
      resourceType: 'OrdersRefunds',
      providerOperationId: operationId,
      providerStatus: 'RUNNING',
      objectCount: '120',
      historyAccess: 'LAST_60_DAYS',
    });
    expect(integrationService.completeSyncRun).not.toHaveBeenCalled();
  });

  it('returns an already-finished SyncRun without calling Shopify again', async () => {
    const { integrationService, service } = buildService();
    vi.mocked(integrationService.getShopifySyncRun).mockResolvedValue({
      id: syncRunId,
      status: 'SUCCEEDED',
      providerOperationId: operationId,
      recordsRead: 25,
      recordsWritten: 25,
      lastError: null,
      finishedAt: new Date('2026-08-20T12:00:00.000Z'),
      apiVersion: '2026-07',
      shopifyConnectionId: connectionId,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.getOrderHistoryBackfill(storeId, syncRunId);

    expect(result).toMatchObject({ status: 'SUCCEEDED', recordsRead: 25, recordsWritten: 25 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
