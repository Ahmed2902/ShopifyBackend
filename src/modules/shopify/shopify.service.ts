import { AppError } from '../../errors/app-error.js';
import type { IntegrationService } from '../integrations/integration.service.js';
import { ShopifyBulkService } from './bulk/shopify-bulk.service.js';
import { ShopifyCatalogService } from './catalog/shopify-catalog.service.js';
import { ShopifyInventoryService } from './inventory/shopify-inventory.service.js';
import { ShopifyOrderRepository } from './order/shopify-order.repository.js';
import { ShopifyOrderService } from './order/shopify-order.service.js';
import type { ShopifyRepository } from './shopify.repository.js';
import type { ShopifyShopProfile } from './shopify.schema.js';
import { ShopifyApiService } from './shared/shopify-api.service.js';
import { ShopifyAuthService } from './shared/shopify-auth.service.js';
import type { ShopifySyncContext } from './shopify.types.js';
import { normalizeShopDomain } from './shopify.utils.js';
import { ShopifyWebhookRepository } from './webhook/shopify-webhook.repository.js';
import { ShopifyWebhookService } from './webhook/shopify-webhook.service.js';
import { ShopifyWebhookSubscriptionService } from './webhook/shopify-webhook-subscription.service.js';

const ORDER_HISTORY_RESOURCE = 'OrdersRefunds';

export class ShopifyService {
  private readonly apiService: ShopifyApiService;
  private readonly authService: ShopifyAuthService;
  private readonly catalogService: ShopifyCatalogService;
  private readonly inventoryService: ShopifyInventoryService;
  private readonly orderService: ShopifyOrderService;
  private readonly webhookSubscriptionService: ShopifyWebhookSubscriptionService;
  private readonly webhookService: ShopifyWebhookService;

  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
    orderRepository: ShopifyOrderRepository = new ShopifyOrderRepository(),
    webhookRepository: ShopifyWebhookRepository = new ShopifyWebhookRepository(),
  ) {
    this.apiService = new ShopifyApiService(repository);
    this.authService = new ShopifyAuthService(repository, this.apiService);
    this.catalogService = new ShopifyCatalogService(repository, integrationService, this.apiService);
    this.inventoryService = new ShopifyInventoryService(repository, integrationService, this.apiService);
    this.orderService = new ShopifyOrderService(
      orderRepository,
      this.apiService,
      new ShopifyBulkService(this.apiService),
    );
    this.webhookSubscriptionService = new ShopifyWebhookSubscriptionService(this.apiService);
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
    await this.ensureWebhookSubscriptions(result.storeId);
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

  async syncStoreData(storeId: string) {
    const { store, connection } = await this.requireActiveConnection(storeId);
    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    await this.webhookSubscriptionService.ensure({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      scopes: connection.scopes,
    });

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: connection.apiVersion,
    });
    const syncContext = this.buildSyncContext(
      storeId,
      store.myshopifyDomain,
      accessToken,
      connection,
      syncRun.id,
    );

    try {
      await this.syncShopProfile(syncContext);
      const catalog = await this.catalogService.sync(syncContext);
      const snapshotSource = connection.lastSyncedAt ? 'MANUAL_RECONCILIATION' : 'INITIAL_SYNC';
      const inventory = await this.inventoryService.sync(syncContext, snapshotSource);

      const breakdown = {
        shop: 1,
        products: catalog.products.written,
        variants: catalog.variants.written,
        locations: inventory.locations.written,
        inventoryLevels: inventory.inventoryLevels.written,
      };
      const recordsRead =
        1 +
        catalog.products.read +
        catalog.variants.read +
        inventory.locations.read +
        inventory.inventoryLevels.read;
      const recordsWritten =
        1 +
        catalog.products.written +
        catalog.variants.written +
        inventory.locations.written +
        inventory.inventoryLevels.written;

      await this.repository.markConnectionSynced(connection.id);
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead, recordsWritten });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: 'CatalogInventory' as const,
        recordsRead,
        recordsWritten,
        breakdown,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async startOrderHistoryBackfill(storeId: string) {
    const { store, connection } = await this.requireActiveConnection(storeId);
    this.requireOrderScope(connection.scopes);
    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    await this.webhookSubscriptionService.ensure({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      scopes: connection.scopes,
    });

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: ORDER_HISTORY_RESOURCE,
      mode: 'BACKFILL',
      apiVersion: connection.apiVersion,
    });
    const syncContext = this.buildSyncContext(
      storeId,
      store.myshopifyDomain,
      accessToken,
      connection,
      syncRun.id,
    );

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
        historyAccess: this.historyAccess(connection.scopes),
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

    const { store, connection } = await this.requireActiveConnection(storeId);
    this.requireOrderScope(connection.scopes);
    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    const syncContext = this.buildSyncContext(
      storeId,
      store.myshopifyDomain,
      accessToken,
      connection,
      syncRun.id,
    );

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
          historyAccess: this.historyAccess(connection.scopes),
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
        historyAccess: this.historyAccess(connection.scopes),
        recordsRead: inspection.recordsRead,
        recordsWritten: inspection.recordsWritten,
        breakdown: inspection.breakdown,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  private async ensureWebhookSubscriptions(storeId: string): Promise<void> {
    const { store, connection } = await this.requireActiveConnection(storeId);
    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    await this.webhookSubscriptionService.ensure({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      scopes: connection.scopes,
    });
  }

  private async requireActiveConnection(storeId: string) {
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

    return { store, connection };
  }

  private requireOrderScope(scopes: string[]): void {
    if (!scopes.includes('read_orders') && !scopes.includes('write_orders')) {
      throw new AppError(
        'Shopify order access is not authorized for this connection',
        409,
        'SHOPIFY_ORDER_SCOPE_REQUIRED',
      );
    }
  }

  private historyAccess(scopes: string[]) {
    return scopes.includes('read_all_orders') ? ('ALL_ORDERS' as const) : ('LAST_60_DAYS' as const);
  }

  private buildSyncContext(
    storeId: string,
    shop: string,
    accessToken: string,
    connection: { id: string; apiVersion: string },
    syncRunId: string,
  ): ShopifySyncContext {
    return {
      storeId,
      shop,
      accessToken,
      connectionId: connection.id,
      apiVersion: connection.apiVersion,
      syncRunId,
    };
  }

  private async syncShopProfile(input: ShopifySyncContext): Promise<ShopifyShopProfile> {
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

    const normalizedProfile: ShopifyShopProfile = { ...profile, myshopifyDomain: canonicalDomain };
    await this.repository.updateStoreProfile(input.storeId, normalizedProfile);
    await this.integrationService.recordExternalPayload({
      provider: 'SHOPIFY',
      resourceType: 'Shop',
      externalId: normalizedProfile.id,
      apiVersion: input.apiVersion,
      payload: normalizedProfile,
      syncRunId: input.syncRunId,
    });
    return normalizedProfile;
  }
}
