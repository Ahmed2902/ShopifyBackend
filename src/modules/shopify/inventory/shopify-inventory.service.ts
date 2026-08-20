import { AppError } from '../../../errors/app-error.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import type { ShopifyRepository } from '../shopify.repository.js';
import { LOCATION_INVENTORY_QUERY, LOCATIONS_QUERY } from '../shopify.queries.js';
import {
  shopifyInventoryLevelConnectionSchema,
  shopifyInventoryLevelSchema,
  shopifyLocationConnectionSchema,
  shopifyLocationSchema,
} from '../shopify.schema.js';
import type {
  ShopifyInventorySnapshotSource,
  ShopifyLocationInventoryQueryData,
  ShopifyLocationsQueryData,
  ShopifyLocationSyncStats,
  ShopifyRequestContext,
  ShopifySyncContext,
  ShopifySyncStats,
} from '../shopify.types.js';
import { paginateShopifyConnection } from '../shopify.utils.js';
import type { ShopifyApiService } from '../shared/shopify-api.service.js';
import {
  INVENTORY_LEVEL_BY_ITEM_LOCATION_QUERY,
  LOCATION_BY_ID_QUERY,
} from './shopify-inventory.queries.js';

const SHOPIFY_PAGE_SIZE = 100;
const REQUIRED_INVENTORY_STATES = [
  'available',
  'incoming',
  'committed',
  'damaged',
  'on_hand',
  'quality_control',
  'reserved',
  'safety_stock',
] as const;

export class ShopifyInventoryService {
  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
    private readonly apiService: ShopifyApiService,
  ) {}

  async sync(
    input: ShopifySyncContext,
    snapshotSource: ShopifyInventorySnapshotSource,
  ): Promise<{
    locations: ShopifyLocationSyncStats;
    inventoryLevels: ShopifySyncStats;
  }> {
    const locations = await this.syncLocations(input);
    await this.repository.markMissingLocationsDeleted(input.storeId, locations.ids);
    const inventoryLevels = { read: 0, written: 0 };

    for (const locationId of locations.ids) {
      const stats = await this.syncLocationInventory(input, locationId, snapshotSource);
      inventoryLevels.read += stats.read;
      inventoryLevels.written += stats.written;
    }

    return { locations, inventoryLevels };
  }

  async reconcileLocation(
    input: ShopifyRequestContext,
    locationId: string,
  ): Promise<{ found: boolean }> {
    const data = await this.apiService.requestAdminGraphql<{ location: unknown | null }>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: LOCATION_BY_ID_QUERY,
      variables: { id: locationId },
    });
    if (!data.location) return { found: false };

    const location = shopifyLocationSchema.safeParse(data.location);
    if (!location.success || location.data.id !== locationId) {
      throw new AppError(
        'Shopify location webhook reconciliation returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    await this.repository.upsertLocation(input.storeId, location.data);
    return { found: true };
  }

  async reconcileInventoryLevel(
    input: ShopifyRequestContext,
    inventoryItemId: string,
    locationId: string,
  ): Promise<{ found: boolean }> {
    const data = await this.apiService.requestAdminGraphql<{
      inventoryItem: { inventoryLevel: unknown | null } | null;
    }>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: INVENTORY_LEVEL_BY_ITEM_LOCATION_QUERY,
      variables: { inventoryItemId, locationId },
    });
    const rawLevel = data.inventoryItem?.inventoryLevel ?? null;
    if (!rawLevel) return { found: false };

    const level = shopifyInventoryLevelSchema.safeParse(rawLevel);
    if (!level.success) {
      throw new AppError(
        'Shopify inventory webhook reconciliation returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    if (level.data.item.id !== inventoryItemId || level.data.location.id !== locationId) {
      throw new AppError(
        'Shopify returned a different inventory level during webhook reconciliation',
        502,
        'SHOPIFY_CATALOG_INCONSISTENT',
      );
    }

    this.assertInventoryQuantities(level.data.quantities.map((quantity) => quantity.name));
    const persisted = await this.repository.upsertInventoryLevel(
      input.storeId,
      level.data,
      'WEBHOOK_RECONCILIATION',
    );
    if (!persisted) {
      throw new AppError(
        'Shopify inventory webhook references catalog data that is not synchronized',
        502,
        'SHOPIFY_CATALOG_INCONSISTENT',
      );
    }
    return { found: true };
  }

  private async syncLocations(input: ShopifySyncContext): Promise<ShopifyLocationSyncStats> {
    let read = 0;
    let written = 0;
    const ids: string[] = [];

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<ShopifyLocationsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: LOCATIONS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyLocationConnectionSchema.safeParse(data.locations);
      if (!connection.success) {
        throw new AppError('Shopify locations query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      await this.recordPagePayload(input, 'LocationsPage', connection.data);
      return connection.data;
    });

    for await (const locations of pages) {
      read += locations.length;
      for (const location of locations) {
        await this.repository.upsertLocation(input.storeId, location);
        ids.push(location.id);
        written += 1;
      }
    }

    return { read, written, ids };
  }

  private async syncLocationInventory(
    input: ShopifySyncContext,
    locationId: string,
    snapshotSource: ShopifyInventorySnapshotSource,
  ): Promise<ShopifySyncStats> {
    let read = 0;
    let written = 0;
    const inventoryItemIds: string[] = [];

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<ShopifyLocationInventoryQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: LOCATION_INVENTORY_QUERY,
        variables: { locationId, first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      if (!data.location) {
        throw new AppError('Shopify location disappeared during sync', 502, 'SHOPIFY_CATALOG_INCONSISTENT');
      }

      const connection = shopifyInventoryLevelConnectionSchema.safeParse(data.location.inventoryLevels);
      if (!connection.success) {
        throw new AppError(
          'Shopify inventory query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      await this.recordPagePayload(input, 'InventoryLevelsPage', {
        locationId,
        ...connection.data,
      });
      return connection.data;
    });

    for await (const levels of pages) {
      read += levels.length;
      for (const level of levels) {
        this.assertInventoryQuantities(level.quantities.map((quantity) => quantity.name));
        const persisted = await this.repository.upsertInventoryLevel(
          input.storeId,
          level,
          snapshotSource,
        );
        if (!persisted) {
          throw new AppError(
            'Shopify inventory references catalog data that was not synchronized',
            502,
            'SHOPIFY_CATALOG_INCONSISTENT',
          );
        }
        inventoryItemIds.push(level.item.id);
        written += 1;
      }
    }

    await this.repository.deleteMissingInventoryLevelsForLocation(
      input.storeId,
      locationId,
      inventoryItemIds,
    );
    return { read, written };
  }

  private assertInventoryQuantities(names: string[]): void {
    const received = new Set(names);
    for (const required of REQUIRED_INVENTORY_STATES) {
      if (!received.has(required)) {
        throw new AppError(
          `Shopify inventory response omitted ${required}`,
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
    }
  }

  private recordPagePayload(
    input: ShopifySyncContext,
    resourceType: string,
    payload: unknown,
  ) {
    return this.integrationService.recordExternalPayload({
      provider: 'SHOPIFY',
      resourceType,
      apiVersion: input.apiVersion,
      payload,
      syncRunId: input.syncRunId,
    });
  }
}
