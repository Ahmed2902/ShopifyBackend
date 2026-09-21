import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

type RawRecentOrder = {
  id: string;
  name: string;
  shopify_created_at: Date;
  processed_at: Date | null;
  currency_code: string;
  current_total_amount: Prisma.Decimal | string | number | null;
  current_quantity: bigint | number | null;
};

type RawInventoryPreviewRow = {
  inventory_item_id: string;
  tracked: boolean;
  product_id: string;
  product_title: string;
  variant_id: string;
  variant_title: string;
  variant_display_name: string | null;
  available: bigint | number | null;
  incoming: bigint | number | null;
  units_sold: bigint | number | null;
  window_days: number;
  inventory_mode: string;
};

type RawTopProductRow = {
  product_id: string;
  product_title: string;
  order_count: bigint | number | null;
  net_units: bigint | number | null;
  net_revenue: Prisma.Decimal | string | number | null;
};

export type DashboardRecentOrder = {
  id: string;
  name: string;
  shopifyCreatedAt: Date;
  processedAt: Date | null;
  currencyCode: string;
  currentTotalAmount: number;
  currentQuantity: number;
};

export type DashboardInventoryPreview = {
  inventoryMode: string;
  items: Array<{
    inventoryItemId: string;
    product: { id: string; title: string };
    variant: { id: string; title: string; displayName: string | null };
    available: number;
    incoming: number;
    unitsSoldInWindow: number;
    unitsPerDay: number;
    daysCover: number | null;
  }>;
};

export type DashboardTopProduct = {
  product: { id: string; title: string };
  orderCount: number;
  netUnits: number;
  netRevenue: number;
};

export type DashboardInventoryInput = {
  storeId: string;
  days: number;
  from?: string;
  to?: string;
  now: Date;
  limit?: number;
};

export type DashboardTopProductsInput = DashboardInventoryInput;

/** Compact reads used only by the Overview dashboard surface. */
export class DashboardReadRepository {
  async getRecentOrders(storeId: string, limit = 6): Promise<DashboardRecentOrder[]> {
    const rows = await prisma.$queryRaw<RawRecentOrder[]>(Prisma.sql`
      WITH recent_orders AS MATERIALIZED (
        SELECT
          o."id",
          o."name",
          o."shopifyCreatedAt" AS shopify_created_at,
          o."processedAt" AS processed_at,
          o."currencyCode" AS currency_code,
          o."currentTotalAmount" AS current_total_amount
        FROM "Order" o
        WHERE o."storeId" = ${storeId}::uuid
          AND o."isTest" = FALSE
        ORDER BY o."shopifyCreatedAt" DESC, o."id" DESC
        LIMIT ${limit}
      )
      SELECT
        recent."id",
        recent."name",
        recent.shopify_created_at,
        recent.processed_at,
        recent.currency_code,
        recent.current_total_amount,
        COALESCE(SUM(li."currentQuantity"), 0) AS current_quantity
      FROM recent_orders recent
      LEFT JOIN "OrderLineItem" li ON li."orderId" = recent."id"
      GROUP BY
        recent."id",
        recent."name",
        recent.shopify_created_at,
        recent.processed_at,
        recent.currency_code,
        recent.current_total_amount
      ORDER BY recent.shopify_created_at DESC, recent."id" DESC
    `);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      shopifyCreatedAt: row.shopify_created_at,
      processedAt: row.processed_at,
      currencyCode: row.currency_code,
      currentTotalAmount: Number(row.current_total_amount ?? 0),
      currentQuantity: Number(row.current_quantity ?? 0),
    }));
  }

  async getTopProducts(input: DashboardTopProductsInput): Promise<DashboardTopProduct[]> {
    const limit = input.limit ?? 5;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const rows = await prisma.$queryRaw<RawTopProductRow[]>(Prisma.sql`
      WITH config AS (
        SELECT
          s."id" AS store_id,
          s."ianaTimezone" AS time_zone,
          s."currencyCode" AS currency_code,
          CASE
            WHEN ${from}::text IS NOT NULL THEN ${from}::date
            ELSE ((${input.now}::timestamptz AT TIME ZONE s."ianaTimezone")::date - ${input.days}::int)
          END AS from_date,
          CASE
            WHEN ${to}::text IS NOT NULL THEN ${to}::date
            ELSE ((${input.now}::timestamptz AT TIME ZONE s."ianaTimezone")::date - 1)
          END AS to_date
        FROM "Store" s
        WHERE s."id" = ${input.storeId}::uuid
      ),
      scoped_lines AS MATERIALIZED (
        SELECT
          li."id",
          li."orderId",
          li."productId",
          li."quantity",
          COALESCE(li."discountedTotal", 0) AS product_revenue
        FROM "OrderLineItem" li
        INNER JOIN "Order" o ON o."id" = li."orderId"
        CROSS JOIN config
        WHERE li."productId" IS NOT NULL
          AND o."storeId" = config.store_id
          AND o."isTest" = FALSE
          AND o."cancelledAt" IS NULL
          AND o."currencyCode" = config.currency_code
          AND COALESCE(o."processedAt", o."shopifyCreatedAt") >= (config.from_date::timestamp AT TIME ZONE config.time_zone)
          AND COALESCE(o."processedAt", o."shopifyCreatedAt") < ((config.to_date + 1)::timestamp AT TIME ZONE config.time_zone)
      ),
      refunds AS (
        SELECT
          rli."orderLineItemId" AS order_line_item_id,
          COALESCE(SUM(rli."quantity"), 0) AS refunded_units,
          COALESCE(SUM(rli."subtotal"), 0) AS refund_value
        FROM "RefundLineItem" rli
        INNER JOIN scoped_lines scoped ON scoped."id" = rli."orderLineItemId"
        GROUP BY rli."orderLineItemId"
      ),
      product_rollup AS (
        SELECT
          scoped."productId" AS product_id,
          COUNT(DISTINCT scoped."orderId") AS order_count,
          GREATEST(COALESCE(SUM(scoped."quantity" - COALESCE(refunds.refunded_units, 0)), 0), 0) AS net_units,
          GREATEST(COALESCE(SUM(scoped.product_revenue - COALESCE(refunds.refund_value, 0)), 0), 0) AS net_revenue
        FROM scoped_lines scoped
        LEFT JOIN refunds ON refunds.order_line_item_id = scoped."id"
        GROUP BY scoped."productId"
      )
      SELECT
        rollup.product_id,
        product."title" AS product_title,
        rollup.order_count,
        rollup.net_units,
        rollup.net_revenue
      FROM product_rollup rollup
      INNER JOIN "Product" product ON product."id" = rollup.product_id
      WHERE product."storeId" = ${input.storeId}::uuid
        AND product."deletedAt" IS NULL
      ORDER BY rollup.net_revenue DESC, rollup.net_units DESC, product."title" ASC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      product: { id: row.product_id, title: row.product_title },
      orderCount: Number(row.order_count ?? 0),
      netUnits: Number(row.net_units ?? 0),
      netRevenue: Number(row.net_revenue ?? 0),
    }));
  }

  async getInventoryPreview(input: DashboardInventoryInput): Promise<DashboardInventoryPreview> {
    const limit = input.limit ?? 8;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const rows = await prisma.$queryRaw<RawInventoryPreviewRow[]>(Prisma.sql`
      WITH config AS (
        SELECT
          s."id" AS store_id,
          s."ianaTimezone" AS time_zone,
          s."inventoryIntelligenceMode"::text AS inventory_mode,
          CASE
            WHEN ${from}::text IS NOT NULL THEN ${from}::date
            ELSE ((${input.now}::timestamptz AT TIME ZONE s."ianaTimezone")::date - ${input.days}::int)
          END AS from_date,
          CASE
            WHEN ${to}::text IS NOT NULL THEN ${to}::date
            ELSE ((${input.now}::timestamptz AT TIME ZONE s."ianaTimezone")::date - 1)
          END AS to_date
        FROM "Store" s
        WHERE s."id" = ${input.storeId}::uuid
      ),
      items AS MATERIALIZED (
        SELECT
          ii."id" AS inventory_item_id,
          ii."tracked",
          ii."createdAt" AS created_at,
          v."id" AS variant_id,
          v."title" AS variant_title,
          v."displayName" AS variant_display_name,
          p."id" AS product_id,
          p."title" AS product_title
        FROM "InventoryItem" ii
        INNER JOIN "ProductVariant" v ON v."id" = ii."variantId"
        INNER JOIN "Product" p ON p."id" = v."productId"
        INNER JOIN config ON config.store_id = ii."storeId"
        WHERE ii."deletedAt" IS NULL
          AND v."deletedAt" IS NULL
          AND p."deletedAt" IS NULL
        ORDER BY ii."createdAt" DESC, ii."id" DESC
        LIMIT ${limit}
      ),
      levels AS (
        SELECT
          level."inventoryItemId" AS inventory_item_id,
          COALESCE(SUM(level."available"), 0) AS available,
          COALESCE(SUM(level."incoming"), 0) AS incoming
        FROM "InventoryLevelCurrent" level
        INNER JOIN items ON items.inventory_item_id = level."inventoryItemId"
        INNER JOIN "Location" location ON location."id" = level."locationId"
        INNER JOIN config ON config.store_id = location."storeId"
        WHERE location."deletedAt" IS NULL
          AND location."isActive" = TRUE
        GROUP BY level."inventoryItemId"
      ),
      restocked AS (
        SELECT
          refund_line."orderLineItemId" AS order_line_item_id,
          COALESCE(SUM(refund_line."quantity") FILTER (WHERE refund_line."restocked" = TRUE), 0) AS units
        FROM "RefundLineItem" refund_line
        INNER JOIN "OrderLineItem" order_line ON order_line."id" = refund_line."orderLineItemId"
        INNER JOIN items ON items.variant_id = order_line."variantId"
        GROUP BY refund_line."orderLineItemId"
      ),
      sales AS (
        SELECT
          line."variantId" AS variant_id,
          COALESCE(SUM(GREATEST(line."quantity" - COALESCE(restocked.units, 0), 0)), 0) AS units_sold
        FROM "OrderLineItem" line
        INNER JOIN items ON items.variant_id = line."variantId"
        INNER JOIN "Order" o ON o."id" = line."orderId"
        CROSS JOIN config
        LEFT JOIN restocked ON restocked.order_line_item_id = line."id"
        WHERE o."storeId" = config.store_id
          AND o."isTest" = FALSE
          AND o."cancelledAt" IS NULL
          AND (
            (
              o."processedAt" >= (config.from_date::timestamp AT TIME ZONE config.time_zone)
              AND o."processedAt" < ((config.to_date + 1)::timestamp AT TIME ZONE config.time_zone)
            )
            OR (
              o."processedAt" IS NULL
              AND o."shopifyCreatedAt" >= (config.from_date::timestamp AT TIME ZONE config.time_zone)
              AND o."shopifyCreatedAt" < ((config.to_date + 1)::timestamp AT TIME ZONE config.time_zone)
            )
          )
        GROUP BY line."variantId"
      )
      SELECT
        items.inventory_item_id,
        items.tracked,
        items.product_id,
        items.product_title,
        items.variant_id,
        items.variant_title,
        items.variant_display_name,
        COALESCE(levels.available, 0) AS available,
        COALESCE(levels.incoming, 0) AS incoming,
        COALESCE(sales.units_sold, 0) AS units_sold,
        (config.to_date - config.from_date + 1)::int AS window_days,
        config.inventory_mode
      FROM items
      CROSS JOIN config
      LEFT JOIN levels ON levels.inventory_item_id = items.inventory_item_id
      LEFT JOIN sales ON sales.variant_id = items.variant_id
      ORDER BY items.created_at DESC, items.inventory_item_id DESC
    `);

    const inventoryMode = rows[0]?.inventory_mode ?? 'DISABLED';
    return {
      inventoryMode,
      items: rows.map((row) => {
        const available = Number(row.available ?? 0);
        const unitsSoldInWindow = Number(row.units_sold ?? 0);
        const windowDays = Math.max(1, Number(row.window_days));
        const unitsPerDay = unitsSoldInWindow / windowDays;
        return {
          inventoryItemId: row.inventory_item_id,
          product: { id: row.product_id, title: row.product_title },
          variant: {
            id: row.variant_id,
            title: row.variant_title,
            displayName: row.variant_display_name,
          },
          available,
          incoming: Number(row.incoming ?? 0),
          unitsSoldInWindow,
          unitsPerDay,
          daysCover:
            inventoryMode === 'TRUSTED' && row.tracked && unitsPerDay > 0
              ? Math.max(0, available) / unitsPerDay
              : null,
        };
      }),
    };
  }
}
