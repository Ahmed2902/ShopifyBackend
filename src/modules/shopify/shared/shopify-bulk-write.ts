import type { Prisma } from '../../../generated/prisma/client.js';

// Catalog entity UPSERTs live in the explicitly PostgreSQL-specific module because Prisma Client
// cannot express a heterogeneous page UPSERT with different update values per row. Re-export them
// here temporarily for existing callers while keeping all raw SQL physically isolated.
export {
  bulkUpsertCollections,
  bulkUpsertInventoryItems,
  bulkUpsertProducts,
  bulkUpsertVariants,
} from './shopify-postgres-bulk-upsert.js';

export type ShopifyInventoryLevelClient = Pick<
  Prisma.TransactionClient,
  'inventoryLevelCurrent'
>;

export interface InventoryLevelBulkRow {
  inventoryItemId: string;
  locationId: string;
  available: number;
  incoming: number;
  committed: number;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  qualityControl: number;
  sourceUpdatedAt: Date | null;
}

/**
 * Inventory-level current rows have no dependents keyed by their internal row ID. Prisma can
 * therefore replace a page safely using two bounded statements instead of raw SQL or per-row
 * updates: delete the affected composite keys, then create the new page rows.
 */
export async function bulkReplaceInventoryLevels(
  db: ShopifyInventoryLevelClient,
  rows: InventoryLevelBulkRow[],
  reconciledAt: Date,
): Promise<void> {
  if (rows.length === 0) return;

  await db.inventoryLevelCurrent.deleteMany({
    where: {
      OR: rows.map((row) => ({
        inventoryItemId: row.inventoryItemId,
        locationId: row.locationId,
      })),
    },
  });

  await db.inventoryLevelCurrent.createMany({
    data: rows.map((row) => ({
      ...row,
      lastReconciledAt: reconciledAt,
    })),
  });
}
