import { AppError } from '../../errors/app-error.js';
import { integrationService, type IntegrationService } from '../integrations/integration.service.js';
import { ShopifyRepository } from './shopify.repository.js';

const CATALOG_INVENTORY_RESOURCE = 'CatalogInventory';

/**
 * Request-path facade for manual catalog/inventory syncs.
 *
 * Deliberately validates only local persisted connection state. Access-token refresh/decryption and
 * every Shopify network call belong to the worker after the SyncRun has been durably queued.
 */
export class ShopifySyncQueueService {
  constructor(
    private readonly repository: ShopifyRepository = new ShopifyRepository(),
    private readonly integrations: IntegrationService = integrationService,
  ) {}

  async enqueue(storeId: string) {
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

    const queued = await this.integrations.enqueueExclusiveSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: CATALOG_INVENTORY_RESOURCE,
      mode: 'MANUAL',
      apiVersion: connection.apiVersion,
    });

    return {
      syncRunId: queued.syncRun.id,
      status: queued.syncRun.status,
      resourceType: CATALOG_INVENTORY_RESOURCE,
      queued: queued.created,
    };
  }

  async get(storeId: string, syncRunId: string) {
    const syncRun = await this.integrations.getShopifySyncRun(
      storeId,
      syncRunId,
      CATALOG_INVENTORY_RESOURCE,
    );
    if (!syncRun) {
      throw new AppError('Shopify sync was not found', 404, 'SYNC_RUN_NOT_FOUND');
    }

    return {
      syncRunId: syncRun.id,
      status: syncRun.status,
      resourceType: CATALOG_INVENTORY_RESOURCE,
      recordsRead: syncRun.recordsRead,
      recordsWritten: syncRun.recordsWritten,
      startedAt: syncRun.startedAt,
      finishedAt: syncRun.finishedAt,
      lastError: syncRun.lastError,
    };
  }
}

export const shopifySyncQueueService = new ShopifySyncQueueService();
