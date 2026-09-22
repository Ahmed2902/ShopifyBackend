import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';

type RawInventoryHistoryRow = {
  bucket_date: Date;
  available: bigint | number | null;
  on_hand: bigint | number | null;
  incoming: bigint | number | null;
  committed: bigint | number | null;
};

function numeric(value: bigint | number | null | undefined) {
  return Number(value ?? 0);
}

/**
 * Daily product inventory history. For each store-local day, take the latest observed snapshot for
 * every variant/location pair, then sum those latest levels into a product-level point.
 * This avoids double-counting multiple sync snapshots from the same day.
 */
export class ProductInventoryHistoryReadService {
  async read(storeId: string, productId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ianaTimezone: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);

    const rows = await prisma.$queryRaw<RawInventoryHistoryRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT
          (snapshot."observedAt" AT TIME ZONE ${store.ianaTimezone})::date AS bucket_date,
          snapshot."available",
          snapshot."onHand",
          snapshot."incoming",
          snapshot."committed",
          ROW_NUMBER() OVER (
            PARTITION BY
              snapshot."inventoryItemId",
              snapshot."locationId",
              (snapshot."observedAt" AT TIME ZONE ${store.ianaTimezone})::date
            ORDER BY snapshot."observedAt" DESC, snapshot."id" DESC
          ) AS row_number
        FROM "InventorySnapshot" snapshot
        INNER JOIN "InventoryItem" item ON item."id" = snapshot."inventoryItemId"
        INNER JOIN "ProductVariant" variant ON variant."id" = item."variantId"
        WHERE item."storeId" = ${storeId}::uuid
          AND variant."productId" = ${productId}::uuid
          AND item."deletedAt" IS NULL
          AND variant."deletedAt" IS NULL
          AND snapshot."observedAt" BETWEEN ${windows.current.instantFrom} AND ${windows.current.instantTo}
      )
      SELECT
        ranked.bucket_date,
        COALESCE(SUM(ranked."available"), 0) AS available,
        COALESCE(SUM(ranked."onHand"), 0) AS on_hand,
        COALESCE(SUM(ranked."incoming"), 0) AS incoming,
        COALESCE(SUM(ranked."committed"), 0) AS committed
      FROM ranked
      WHERE ranked.row_number = 1
      GROUP BY ranked.bucket_date
      ORDER BY ranked.bucket_date ASC
    `);

    return {
      window: windowResponse(windows),
      product,
      methodology: 'LATEST_DAILY_VARIANT_LOCATION_SNAPSHOT_SUM',
      points: rows.map((row) => ({
        date: row.bucket_date.toISOString().slice(0, 10),
        available: numeric(row.available),
        onHand: numeric(row.on_hand),
        incoming: numeric(row.incoming),
        committed: numeric(row.committed),
      })),
    };
  }
}

export const productInventoryHistoryReadService = new ProductInventoryHistoryReadService();
