import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyCatalogService } from '../../../src/modules/shopify/catalog/shopify-catalog.service.js';
import type { ShopifyInventoryService } from '../../../src/modules/shopify/inventory/shopify-inventory.service.js';
import type { ShopifyOrderService } from '../../../src/modules/shopify/order/shopify-order.service.js';
import type { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';
import type { ShopifyWebhookRepository } from '../../../src/modules/shopify/webhook/shopify-webhook.repository.js';
import { ShopifyWebhookService } from '../../../src/modules/shopify/webhook/shopify-webhook.service.js';

const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const syncRunId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const connection = {
  id: connectionId,
  status: 'ACTIVE',
  accessTokenCiphertext: 'ciphertext',
  accessTokenExpiresAt: null,
  refreshTokenCiphertext: null,
  refreshTokenExpiresAt: null,
  scopes: ['read_products', 'read_inventory', 'read_locations', 'read_orders'],
  apiVersion: '2026-07',
  store: { id: storeId, myshopifyDomain: 'example-store.myshopify.com' },
};

function delivery(topic: string, payload: unknown, attempts = 1) {
  return {
    id: deliveryId,
    topic,
    apiVersion: '2026-07',
    payload,
    attempts,
    shopifyConnectionId: connectionId,
  };
}

function buildService(currentDelivery = delivery('products/update', { id: 1 })) {
  const repository = {
    findConnectionByShopDomain: vi.fn().mockResolvedValue(connection),
    findConnectionById: vi.fn().mockResolvedValue(connection),
    createDelivery: vi.fn().mockResolvedValue({
      delivery: { id: deliveryId },
      duplicate: false,
    }),
    listDueDeliveryIds: vi.fn().mockResolvedValue([deliveryId]),
    tryClaim: vi.fn().mockResolvedValue(true),
    getDelivery: vi.fn().mockResolvedValue(currentDelivery),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markIgnored: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markConnectionUninstalled: vi.fn().mockResolvedValue(undefined),
    markProductDeleted: vi.fn().mockResolvedValue(true),
    markMissingProductVariantsDeleted: vi.fn().mockResolvedValue(0),
    markLocationDeleted: vi.fn().mockResolvedValue(undefined),
    deleteInventoryLevel: vi.fn().mockResolvedValue(true),
    deleteOrder: vi.fn().mockResolvedValue(true),
    findOrderBackfillByOperation: vi.fn().mockResolvedValue({
      id: syncRunId,
      status: 'RUNNING',
      providerOperationId: 'gid://shopify/BulkOperation/99',
      recordsRead: 0,
      recordsWritten: 0,
    }),
  } as unknown as ShopifyWebhookRepository;

  const integrationService = {
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;

  const authService = {
    resolveAccessToken: vi.fn().mockResolvedValue('access-token'),
  } as unknown as ShopifyAuthService;
  const catalogService = {
    reconcileProduct: vi.fn().mockResolvedValue({
      found: true,
      variantIds: ['gid://shopify/ProductVariant/10'],
    }),
    invalidatePixelResolution: vi.fn().mockResolvedValue(0),
  } as unknown as ShopifyCatalogService;
  const inventoryService = {
    reconcileLocation: vi.fn().mockResolvedValue({ found: true }),
    reconcileInventoryLevel: vi.fn().mockResolvedValue({ found: true }),
  } as unknown as ShopifyInventoryService;
  const orderService = {
    reconcileOrder: vi.fn().mockResolvedValue({ found: true }),
    inspectBulkBackfill: vi.fn().mockResolvedValue({
      state: 'COMPLETED',
      providerStatus: 'COMPLETED',
      recordsRead: 12,
      recordsWritten: 12,
      breakdown: { orders: 4, lineItems: 6, refunds: 1, refundLineItems: 1 },
    }),
  } as unknown as ShopifyOrderService;

  return {
    repository,
    integrationService,
    authService,
    catalogService,
    inventoryService,
    orderService,
    service: new ShopifyWebhookService(
      repository,
      integrationService,
      authService,
      catalogService,
      inventoryService,
      orderService,
    ),
  };
}

function sign(body: Buffer): string {
  return createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET!).update(body).digest('base64');
}

describe('ShopifyWebhookService', () => {
  it('verifies and durably queues a delivery before acknowledging it', async () => {
    const { repository, service } = buildService();
    const body = Buffer.from('{"id":1}');

    const result = await service.receive(
      {
        hmac: sign(body),
        topic: 'products/update',
        shopDomain: 'example-store.myshopify.com',
        webhookId: 'webhook-1',
        apiVersion: '2026-07',
        triggeredAt: '2026-08-20T16:00:00.000Z',
      },
      body,
    );

    expect(result).toEqual({ deliveryId, duplicate: false, queued: true });
    expect(repository.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        externalDeliveryId: 'webhook-1',
        shopifyConnectionId: connectionId,
        topic: 'products/update',
        payload: { id: 1 },
      }),
    );
  });

  it('does not enqueue a duplicate Shopify delivery twice', async () => {
    const { repository, service } = buildService();
    vi.mocked(repository.createDelivery).mockResolvedValue({
      delivery: { id: deliveryId },
      duplicate: true,
    } as never);
    const body = Buffer.from('{"id":1}');

    const result = await service.receive(
      {
        hmac: sign(body),
        topic: 'products/update',
        shopDomain: 'example-store.myshopify.com',
        webhookId: 'webhook-1',
      },
      body,
    );

    expect(result).toEqual({ deliveryId, duplicate: true, queued: false });
  });

  it('reconciles product updates from Shopify and tombstones variants missing from the current product', async () => {
    const { repository, catalogService, service } = buildService(
      delivery('products/update', { id: 1, admin_graphql_api_id: 'gid://shopify/Product/1' }),
    );

    const result = await service.processDueDeliveries();

    expect(result).toEqual({ claimed: 1, processed: 1 });
    expect(catalogService.reconcileProduct).toHaveBeenCalledWith(
      expect.objectContaining({ storeId, connectionId }),
      'gid://shopify/Product/1',
    );
    expect(repository.markMissingProductVariantsDeleted).toHaveBeenCalledWith(
      storeId,
      'gid://shopify/Product/1',
      ['gid://shopify/ProductVariant/10'],
    );
    expect(catalogService.invalidatePixelResolution).toHaveBeenCalledWith(
      storeId,
      'gid://shopify/Product/1',
    );
    expect(repository.markProcessed).toHaveBeenCalledWith(deliveryId);
  });

  it('processes app uninstall without attempting to refresh or use the access token', async () => {
    const { repository, authService, service } = buildService(delivery('app/uninstalled', { id: 1 }));

    await service.processDueDeliveries();

    expect(repository.markConnectionUninstalled).toHaveBeenCalledWith(connectionId);
    expect(authService.resolveAccessToken).not.toHaveBeenCalled();
    expect(repository.markProcessed).toHaveBeenCalledWith(deliveryId);
  });

  it('removes disconnected current inventory while preserving historical snapshots', async () => {
    const { repository, inventoryService, service } = buildService(
      delivery('inventory_levels/disconnect', { inventory_item_id: 10, location_id: 20 }),
    );

    await service.processDueDeliveries();

    expect(inventoryService.reconcileInventoryLevel).not.toHaveBeenCalled();
    expect(repository.deleteInventoryLevel).toHaveBeenCalledWith(
      storeId,
      'gid://shopify/InventoryItem/10',
      'gid://shopify/Location/20',
    );
  });

  it('reconciles the owning order when a refund is created', async () => {
    const { orderService, service } = buildService(
      delivery('refunds/create', { id: 50, order_id: 77 }),
    );

    await service.processDueDeliveries();

    expect(orderService.reconcileOrder).toHaveBeenCalledWith(
      expect.objectContaining({ storeId }),
      'gid://shopify/Order/77',
    );
  });

  it('finishes a matching historical bulk backfill from BULK_OPERATIONS_FINISH', async () => {
    const { integrationService, orderService, service } = buildService(
      delivery('bulk_operations/finish', {
        admin_graphql_api_id: 'gid://shopify/BulkOperation/99',
        status: 'completed',
      }),
    );

    await service.processDueDeliveries();

    expect(orderService.inspectBulkBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ syncRunId }),
      'gid://shopify/BulkOperation/99',
    );
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 12,
      recordsWritten: 12,
    });
    expect(integrationService.recordExternalPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'OrderHistoryBulkCompletion',
        webhookDeliveryId: deliveryId,
      }),
    );
  });

  it('marks unsupported topics ignored instead of retrying them forever', async () => {
    const { repository, service } = buildService(delivery('shop/update', { id: 1 }));

    await service.processDueDeliveries();

    expect(repository.markIgnored).toHaveBeenCalledWith(
      deliveryId,
      'Unsupported Shopify topic shop/update',
    );
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('records a retryable failure when targeted reconciliation throws', async () => {
    const { repository, catalogService, service } = buildService(
      delivery('products/update', { id: 1 }),
    );
    vi.mocked(catalogService.reconcileProduct).mockRejectedValue(new Error('temporary Shopify failure'));

    const result = await service.processDueDeliveries();

    expect(result).toEqual({ claimed: 1, processed: 0 });
    expect(repository.markFailed).toHaveBeenCalledWith(
      deliveryId,
      1,
      'temporary Shopify failure',
    );
  });
});
