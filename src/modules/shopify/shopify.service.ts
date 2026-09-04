import { AppError } from '../../errors/app-error.js';
import { logger } from '../../lib/logger.js';
import { integrationService, type IntegrationService } from '../integrations/integration.service.js';
import { ShopifyBulkService } from './bulk/shopify-bulk.service.js';
import { ShopifyCatalogRepository } from './catalog/shopify-catalog.repository.js';
import { ShopifyCatalogService } from './catalog/shopify-catalog.service.js';
import { ShopifyInventoryRepository } from './inventory/shopify-inventory.repository.js';
import { ShopifyInventoryService } from './inventory/shopify-inventory.service.js';
import { ShopifyOrderRepository } from './order/shopify-order.repository.js';
import { ShopifyOrderService } from './order/shopify-order.service.js';
import { ShopifyRepository } from './shopify.repository.js';
import { ShopifyApiService } from './shared/shopify-api.service.js';
import { ShopifyAuthService } from './shared/shopify-auth.service.js';
import type { ShopifyInventorySnapshotSource, ShopifySyncContext } from './shopify.types.js';
import { normalizeShopDomain } from './shopify.utils.js';
import { ShopifyWebhookRepository } from './webhook/shopify-webhook.repository.js';
import { ShopifyWebhookService } from './webhook/shopify-webhook.service.js';

const CATALOG_INVENTORY_RESOURCE = 'CatalogInventory';
const ORDER_HISTORY_RESOURCE = 'OrdersRefunds';
const RECONCILIATION_RESOURCE = 'StoreReconciliation';
const FALLBACK_RECONCILIATION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export class ShopifyService {
  private readonly apiService: ShopifyApiService;
  private readonly authService: ShopifyAuthService;
  private readonly catalogService: ShopifyCatalogService;
  private readonly inventoryService: ShopifyInventoryService;
  private readonly orderService: ShopifyOrderService;
  private readonly webhookService: ShopifyWebhookService;

  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
    orderRepository: ShopifyOrderRepository = new ShopifyOrderRepository(),
    webhookRepository: ShopifyWebhookRepository = new ShopifyWebhookRepository(),
    catalogSyncRepository: ShopifyCatalogRepository = new ShopifyCatalogRepository(),
    inventorySyncRepository: ShopifyInventoryRepository = new ShopifyInventoryRepository(),
  ) {
    this.apiService = new ShopifyApiService(repository);
    this.authService = new ShopifyAuthService(repository, this.apiService);
    this.catalogService = new ShopifyCatalogService(
      repository,
      integrationService,
      this.apiService,
      catalogSyncRepository,
    );
    this.inventoryService = new ShopifyInventoryService(
      repository,
      integrationService,
      this.apiService,
      inventorySyncRepository,
    );
    this.orderService = new ShopifyOrderService(
      orderRepository,
      this.apiService,
      new ShopifyBulkService(this.apiService),
    );
    this.webhookService = new ShopifyWebhookService(
      webhookRepository,
      integrationService,
      this.authService,
      this.catalogService,
      this.inventoryService,
      this.orderService,
    );
  }

  beginOAuth(userId: string, requestedShop: string) {
    return this.authService.beginOAuth(userId, requestedShop);
  }

  async completeOAuth(input: {
    code: string;
    shop: string;
    state: string;
    oauthContextCookie: string | undefined;
  }) {
    const result = await this.authService.completeOAuth(input);

    try {
      const latestHistory = await this.integrationService.getLatestShopifySyncRun(
        result.storeId,
        ORDER_HISTORY_RESOURCE,
      );
      if (!latestHistory || !['RUNNING', 'SUCCEEDED'].includes(latestHistory.status)) {
        await this.startOrderHistoryBackfill(result.storeId);
      }
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'SHOPIFY_ORDER_SCOPE_REQUIRED')) {
        logger.warn({ err: error, storeId: result.storeId }, 'Shopify order history did not auto-start');
      }
    }

    return result;
  }

  receiveWebhook(
    headers: {
      hmac?: string;
      topic?: string;
      shopDomain?: string;
      webhookId?: string;
      apiVersion?: string;
      triggeredAt?: string;
    },
    rawBody: Buffer | undefined,
  ) {
    return this.webhookService.receive(headers, rawBody);
  }

  processWebhookQueue(limit?: number) {
    return this.webhookService.processDueDeliveries(limit);
  }

  async syncCatalogAndInventory(storeId: string) {
    const { connection, syncContextBase } = await this.loadSyncTarget(storeId);
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: CATALOG_INVENTORY_RESOURCE,
      mode: 'MANUAL',
      apiVersion: connection.apiVersion,
    });
    const syncContext: ShopifySyncContext = { ...syncContextBase, syncRunId: syncRun.id };

    try {
      const result = await this.syncCatalogInventorySnapshot(
        syncContext,
        connection.lastSyncedAt ? 'MANUAL_RECONCILIATION' : 'INITIAL_SYNC',
      );
      await this.repository.markConnectionSynced(connection.id);
      await this.integrationService.completeSyncRun(syncRun.id, result);
      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: CATALOG_INVENTORY_RESOURCE,
        ...result,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async refreshStoreData(storeId: string) {
    const { connection, syncContextBase } = await this.loadSyncTarget(storeId);
    const previousRun = await this.integrationService.getLastSuccessfulShopifySyncRun(
      connection.id,
      RECONCILIATION_RESOURCE,
    );
    const since =
      previousRun?.finishedAt ?? new Date(Date.now() - FALLBACK_RECONCILIATION_LOOKBACK_MS);
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: RECONCILIATION_RESOURCE,
      mode: 'PERIODIC',
      apiVersion: connection.apiVersion,
    });
    const syncContext: ShopifySyncContext = { ...syncContextBase, syncRunId: syncRun.id };

    try {
      const base = await this.syncCatalogInventorySnapshot(syncContext, 'PERIODIC_RECONCILIATION');
      const commerce = this.canReadOrders(connection.scopes)
        ? await this.orderService.reconcileUpdatedOrders(syncContext, since)
        : null;
      const result = {
        recordsRead: base.recordsRead + (commerce?.recordsRead ?? 0),
        recordsWritten: base.recordsWritten + (commerce?.recordsWritten ?? 0),
        breakdown: {
          ...base.breakdown,
          ordersScanned: commerce?.ordersScanned ?? 0,
          orders: commerce?.breakdown.orders ?? 0,
          orderLineItems: commerce?.breakdown.lineItems ?? 0,
          refunds: commerce?.breakdown.refunds ?? 0,
          refundLineItems: commerce?.breakdown.refundLineItems ?? 0,
          commerceSkipped: !commerce,
        },
      };

      await this.repository.markConnectionSynced(connection.id);
      await this.integrationService.completeSyncRun(syncRun.id, result);
      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: RECONCILIATION_RESOURCE,
        since,
        ...result,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async startOrderHistoryBackfill(storeId: string) {
    const { connection, syncContextBase } = await this.loadSyncTarget(storeId);
    this.assertOrderReadAccess(connection.scopes);

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: ORDER_HISTORY_RESOURCE,
      mode: 'BACKFILL',
      apiVersion: connection.apiVersion,
    });
    const syncContext: ShopifySyncContext = { ...syncContextBase, syncRunId: syncRun.id };

    try {
      const operation = await this.orderService.startBulkBackfill(syncContext);
      await this.integrationService.attachProviderOperation(syncRun.id, operation.id);
      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'OrderHistoryBulkOperation',
        externalId: operation.id,
        apiVersion: connection.apiVersion,
        payload: operation,
        syncRunId: syncRun.id,
      });

      return {
        syncRunId: syncRun.id,
        status: 'RUNNING' as const,
        resourceType: ORDER_HISTORY_RESOURCE,
        providerOperationId: operation.id,
        providerStatus: operation.status,
        historyAccess: this.getOrderHistoryAccess(connection.scopes),
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async getOrderHistoryBackfill(storeId: string, syncRunId: string) {
    const syncRun = await this.integrationService.getShopifySyncRun(
      storeId,
      syncRunId,
      ORDER_HISTORY_RESOURCE,
    );
    if (!syncRun) {
      throw new AppError('Shopify order backfill was not found', 404, 'SYNC_RUN_NOT_FOUND');
    }
    if (syncRun.status !== 'RUNNING') {
      return {
        syncRunId: syncRun.id,
        status: syncRun.status,
        resourceType: ORDER_HISTORY_RESOURCE,
        recordsRead: syncRun.recordsRead,
        recordsWritten: syncRun.recordsWritten,
        lastError: syncRun.lastError,
        finishedAt: syncRun.finishedAt,
      };
    }
    if (!syncRun.providerOperationId) {
      const error = new AppError(
        'Shopify order backfill is missing its bulk-operation ID',
        500,
        'SYNC_RUN_INVALID',
      );
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }

    const { connection, syncContextBase } = await this.loadSyncTarget(storeId);
    this.assertOrderReadAccess(connection.scopes);
    const syncContext: ShopifySyncContext = { ...syncContextBase, syncRunId: syncRun.id };

    try {
      const inspection = await this.orderService.inspectBulkBackfill(
        syncContext,
        syncRun.providerOperationId,
      );
      if (inspection.state === 'RUNNING') {
        return {
          syncRunId: syncRun.id,
          status: 'RUNNING' as const,
          resourceType: ORDER_HISTORY_RESOURCE,
          providerOperationId: syncRun.providerOperationId,
          providerStatus: inspection.providerStatus,
          objectCount: inspection.objectCount,
          historyAccess: this.getOrderHistoryAccess(connection.scopes),
        };
      }

      if (inspection.state === 'FAILED') {
        const error = new AppError(
          inspection.errorCode
            ? `Shopify bulk order backfill failed: ${inspection.errorCode}`
            : `Shopify bulk order backfill ended with ${inspection.providerStatus}`,
          502,
          'SHOPIFY_BULK_FAILED',
        );
        await this.integrationService.failSyncRun(syncRun.id, error);
        return {
          syncRunId: syncRun.id,
          status: 'FAILED' as const,
          resourceType: ORDER_HISTORY_RESOURCE,
          providerOperationId: syncRun.providerOperationId,
          providerStatus: inspection.providerStatus,
          lastError: error.message,
        };
      }

      await this.integrationService.completeSyncRun(syncRun.id, {
        recordsRead: inspection.recordsRead,
        recordsWritten: inspection.recordsWritten,
      });
      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'OrderHistoryBulkCompletion',
        externalId: syncRun.providerOperationId,
        apiVersion: connection.apiVersion,
        payload: {
          providerStatus: inspection.providerStatus,
          breakdown: inspection.breakdown,
        },
        syncRunId: syncRun.id,
      });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: ORDER_HISTORY_RESOURCE,
        providerOperationId: syncRun.providerOperationId,
        providerStatus: inspection.providerStatus,
        historyAccess: this.getOrderHistoryAccess(connection.scopes),
        recordsRead: inspection.recordsRead,
        recordsWritten: inspection.recordsWritten,
        breakdown: inspection.breakdown,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  private async loadSyncTarget(storeId: string) {
    const store = await this.repository.findConnectionForSync(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const connection = store.shopifyConnection;
    if (!connection) {
      throw new AppError('Shopify is not connected for this store', 409, 'SHOPIFY_NOT_CONNECTED');
    }
    if (connection.status !== 'ACTIVE') {
      throw new AppError(
        'Shopify connection requires merchant attention',
        409,
        'SHOPIFY_CONNECTION_INACTIVE',
      );
    }

    return {
      connection,
      syncContextBase: {
        storeId,
        shop: store.myshopifyDomain,
        accessToken: await this.authService.resolveAccessToken(store.myshopifyDomain, connection),
        connectionId: connection.id,
        apiVersion: connection.apiVersion,
      },
    };
  }

  private canReadOrders(scopes: string[]): boolean {
    return scopes.includes('read_orders') || scopes.includes('write_orders');
  }

  private assertOrderReadAccess(scopes: string[]): void {
    if (!this.canReadOrders(scopes)) {
      throw new AppError(
        'Shopify order access is not authorized for this connection',
        409,
        'SHOPIFY_ORDER_SCOPE_REQUIRED',
      );
    }
  }

  private getOrderHistoryAccess(scopes: string[]) {
    return scopes.includes('read_all_orders') ? ('ALL_ORDERS' as const) : ('LAST_60_DAYS' as const);
  }

  private async syncCatalogInventorySnapshot(
    input: ShopifySyncContext,
    snapshotSource: ShopifyInventorySnapshotSource,
  ) {
    const [, catalog] = await Promise.all([
      this.syncStoreProfile(input),
      this.catalogService.sync(input),
    ]);
    const inventory = await this.inventoryService.sync(input, snapshotSource);
    return {
      recordsRead:
        1 +
        catalog.products.read +
        catalog.variants.read +
        catalog.collections.read +
        inventory.locations.read +
        inventory.inventoryLevels.read,
      recordsWritten:
        1 +
        catalog.products.written +
        catalog.variants.written +
        catalog.collections.written +
        inventory.locations.written +
        inventory.inventoryLevels.written,
      breakdown: {
        shop: 1,
        products: catalog.products.written,
        variants: catalog.variants.written,
        collections: catalog.collections.written,
        locations: inventory.locations.written,
        inventoryLevels: inventory.inventoryLevels.written,
      },
    };
  }

  private async syncStoreProfile(input: ShopifySyncContext): Promise<void> {
    const profile = await this.apiService.fetchShopProfile(
      input.shop,
      input.accessToken,
      input.apiVersion,
      input.connectionId,
    );
    const canonicalDomain = normalizeShopDomain(profile.myshopifyDomain);
    if (canonicalDomain !== input.shop) {
      throw new AppError('Shopify returned a different shop identity', 401, 'SHOP_IDENTITY_MISMATCH');
    }

    const normalizedProfile = { ...profile, myshopifyDomain: canonicalDomain };
    await this.repository.updateStoreProfile(input.storeId, normalizedProfile);
    await this.integrationService.recordExternalPayload({
      provider: 'SHOPIFY',
      resourceType: 'Shop',
      externalId: normalizedProfile.id,
      apiVersion: input.apiVersion,
      payload: normalizedProfile,
      syncRunId: input.syncRunId,
    });
  }
}

export const shopifyService = new ShopifyService(
  new ShopifyRepository(),
  integrationService,
  new ShopifyOrderRepository(),
  new ShopifyWebhookRepository(),
);
