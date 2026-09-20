import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type { ShopifyInventoryLevel, ShopifyLocation } from '../shopify.schema.js';
import { bulkReplaceInventoryLevels } from '../shared/shopify-bulk-write.js';
import type { ShopifyInventorySnapshotSource } from '../shopify.types.js';

const DB_WRITE_CONCURRENCY = 12;

interface InventoryQuantityState {
  available: number;
  incoming: number;
  committed: number;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  qualityControl: number;
}

function optionalDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function inventoryState(level: ShopifyInventoryLevel): InventoryQuantityState {
  const quantities = new Map(level.quantities.map((entry) => [entry.name, entry.quantity]));
  return {
    available: quantities.get('available') ?? 0,
    incoming: quantities.get('incoming') ?? 0,
    committed: quantities.get('committed') ?? 0,
    onHand: quantities.get('on_hand') ?? 0,
    reserved: quantities.get('reserved') ?? 0,
    damaged: quantities.get('damaged') ?? 0,
    safetyStock: quantities.get('safety_stock') ?? 0,
    qualityControl: quantities.get('quality_control') ?? 0,
  };
}

async function runBatched<T>(items: T[], task: (item: T) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < items.length; index += DB_WRITE_CONCURRENCY) {
    await Promise.all(items.slice(index, index + DB_WRITE_CONCURRENCY).map(task));
  }
}

function locationData(location: ShopifyLocation) {
  return {
    name: location.name,
    isActive: location.isActive,
    fulfillsOnlineOrders: location.fulfillsOnlineOrders ?? null,
    shipsInventory: location.shipsInventory ?? null,
    hasActiveInventory: location.hasActiveInventory ?? null,
    deactivatedAt: optionalDate(location.deactivatedAt),
    addressJson: location.address
      ? (location.address as unknown as Prisma.InputJsonValue)
      : undefined,
    shopifyCreatedAt: optionalDate(location.createdAt),
    shopifyUpdatedAt: optionalDate(location.updatedAt),
    deletedAt: null,
    rawJson: location as unknown as Prisma.InputJsonValue,
  };
}

/** Full-sync persistence for locations and inventory pages. */
export class ShopifyInventoryRepository {
  async persistLocations(storeId: string, locations: ShopifyLocation[]): Promise<void> {
    if (locations.length === 0) return;

    const ids = locations.map((location) => location.id);
    const existing = await prisma.location.findMany({
      where: { storeId, shopifyLocationId: { in: ids } },
      select: { id: true, shopifyLocationId: true },
    });
    const existingMap = new Map(
      existing.map((location) => [location.shopifyLocationId, location.id]),
    );

    const newLocations = locations.filter((location) => !existingMap.has(location.id));
    if (newLocations.length > 0) {
      await prisma.location.createMany({
        data: newLocations.map((location) => ({
          storeId,
          shopifyLocationId: location.id,
          ...locationData(location),
        })),
        skipDuplicates: true,
      });
    }

    const updates = locations.filter((location) => existingMap.has(location.id));
    await runBatched(updates, (location) =>
      prisma.location.update({
        where: { id: existingMap.get(location.id)! },
        data: locationData(location),
        select: { id: true },
      }),
    );
  }

  async persistInventoryLevels(
    storeId: string,
    levels: ShopifyInventoryLevel[],
    source: ShopifyInventorySnapshotSource,
  ): Promise<boolean> {
    if (levels.length === 0) return true;

    const inventoryExternalIds = [...new Set(levels.map((level) => level.item.id))];
    const locationExternalIds = [...new Set(levels.map((level) => level.location.id))];
    const [items, locations] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: {
          storeId,
          shopifyInventoryItemId: { in: inventoryExternalIds },
          deletedAt: null,
        },
        select: { id: true, shopifyInventoryItemId: true },
      }),
      prisma.location.findMany({
        where: { storeId, shopifyLocationId: { in: locationExternalIds }, deletedAt: null },
        select: { id: true, shopifyLocationId: true },
      }),
    ]);

    const itemMap = new Map(items.map((item) => [item.shopifyInventoryItemId, item.id]));
    const locationMap = new Map(
      locations.map((location) => [location.shopifyLocationId, location.id]),
    );
    if (
      inventoryExternalIds.some((id) => !itemMap.has(id)) ||
      locationExternalIds.some((id) => !locationMap.has(id))
    ) {
      return false;
    }

    const reconciledAt = new Date();
    const rows = levels.map((level) => {
      const inventoryItemId = itemMap.get(level.item.id)!;
      const locationId = locationMap.get(level.location.id)!;
      const quantities = inventoryState(level);
      return {
        level,
        inventoryItemId,
        locationId,
        quantities,
        sourceUpdatedAt: optionalDate(level.updatedAt),
        observedAt: optionalDate(level.updatedAt) ?? reconciledAt,
      };
    });

    await prisma.$transaction(async (tx) => {
      await bulkReplaceInventoryLevels(
        tx,
        rows.map((row) => ({
          inventoryItemId: row.inventoryItemId,
          locationId: row.locationId,
          ...row.quantities,
          sourceUpdatedAt: row.sourceUpdatedAt,
        })),
        reconciledAt,
      );

      await tx.inventorySnapshot.createMany({
        data: rows.map((row) => ({
          inventoryItemId: row.inventoryItemId,
          locationId: row.locationId,
          ...row.quantities,
          observedAt: row.observedAt,
          source,
        })),
      });
    });

    return true;
  }
}
