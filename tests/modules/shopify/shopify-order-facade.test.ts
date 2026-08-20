import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyOrderRepository } from '../../../src/modules/shopify/shopify-order.repository.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
    updateSyncRunProgress: vi.fn().mockResolvedValue(undefined),
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
  it('runs an order/refund backfill as its own SyncRun and reports the standard history window', async () => {
    const { integrationService, service } = buildService();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            orders: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const result = await service.syncOrderHistory(storeId);

    expect(result).toEqual({
      syncRunId,
      status: 'SUCCEEDED',
      resourceType: 'OrdersRefunds',
      historyAccess: 'LAST_60_DAYS',
      recordsRead: 0,
      recordsWritten: 0,
      checkpointCursor: null,
      breakdown: {
        orders: 0,
        lineItems: 0,
        refunds: 0,
        refundLineItems: 0,
      },
    });
    expect(integrationService.startSyncRun).toHaveBeenCalledWith({
      provider: 'SHOPIFY',
      connectionId,
      resourceType: 'OrdersRefunds',
      mode: 'BACKFILL',
      apiVersion: '2026-07',
    });
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 0,
      recordsWritten: 0,
    });
  });

  it('does not start a backfill when the connection lacks order scope', async () => {
    const { integrationService, service } = buildService(['read_products']);

    await expect(service.syncOrderHistory(storeId)).rejects.toMatchObject({
      code: 'SHOPIFY_ORDER_SCOPE_REQUIRED',
    });
    expect(integrationService.startSyncRun).not.toHaveBeenCalled();
  });

  it('reports full order-history access when read_all_orders is granted', async () => {
    const { service } = buildService(['read_orders', 'read_all_orders']);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            orders: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const result = await service.syncOrderHistory(storeId);

    expect(result.historyAccess).toBe('ALL_ORDERS');
  });
});
