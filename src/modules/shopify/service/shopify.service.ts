import { AppError } from '../../../errors/app-error.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import { ShopifyOrderRepository } from '../shopify-order.repository.js';
import type { ShopifyRepository } from '../shopify.repository.js';
import type { ShopifyShopProfile } from '../shopify.schema.js';
import type { ShopifySyncContext } from '../shopify.types.js';
import { normalizeShopDomain } from '../shopify.utils.js';
import { ShopifyApiService } from './shopify-api.service.js';
import { ShopifyAuthService } from './shopify-auth.service.js';
import { ShopifyCatalogService } from './shopify-catalog.service.js';
import { ShopifyInventoryService } from './shopify-inventory.service.js';
import { ShopifyOrderService } from './shopify-order.service.js';

export class ShopifyService {
  private readonly apiService: ShopifyApiService;
  private readonly authService: ShopifyAuthService;
  private readonly catalogService: ShopifyCatalogService;
  private readonly inventoryService: ShopifyInventoryService;
  private readonly orderService: ShopifyOrderService;

  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
    orderRepository: ShopifyOrderRepository = new ShopifyOrderRepository(),
  ) {
    this.apiService = new ShopifyApiService(repository);
    this.authService = new ShopifyAuthService(repository, this.apiService);
    this.catalogService = new ShopifyCatalogService(repository, integrationService, this.apiService);
    this.inventoryService = new ShopifyInventoryService(repository, integrationService, this.apiService);
    this.orderService = new ShopifyOrderService(orderRepository, integrationService, this.apiService);
  }

  beginOAuth(userId: string, requestedShop: string) {
    return this.authService.beginOAuth(userId, requestedShop);
  }

  completeOAuth(input: {
    code: string;
    shop: string;
    state: string;
    oauthContextCookie: string | undefined;
  }) {
    return this.authService.completeOAuth(input);
  }

  async syncStoreData(storeId: string) {
    const { store, connection } = await this.requireActiveConnection(storeId);
    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
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

  async syncOrderHistory(storeId: string) {
    const { store, connection } = await this.requireActiveConnection(storeId);
    this.requireOrderScope(connection.scopes);

    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: 'OrdersRefunds',
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
      const result = await this.orderService.sync(syncContext);
      await this.integrationService.completeSyncRun(syncRun.id, {
        recordsRead: result.recordsRead,
        recordsWritten: result.recordsWritten,
      });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: 'OrdersRefunds' as const,
        historyAccess: connection.scopes.includes('read_all_orders')
          ? ('ALL_ORDERS' as const)
          : ('LAST_60_DAYS' as const),
        ...result,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
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
