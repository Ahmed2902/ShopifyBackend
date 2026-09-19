import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export interface IntelligenceCommerceEvidenceRow {
  productId: string;
  shopifyProductId: string;
  title: string;
  sourceOrderLineCount: number;
  soldUnits: number;
  refundedUnits: number;
  restockedUnits: number;
  netUnits: number;
  cogsUnits: number;
  revenue: number;
  refunds: number;
  cogs: number;
  costCoveredUnits: number;
}

export interface IntelligenceInventoryEvidenceRow {
  productId: string;
  sourceInventoryLevelCount: number;
  available: number;
  restockLeadTimeDays: number;
  lowStockThresholdUnits: number;
}

type RawIntelligenceCommerceEvidenceRow = {
  product_id: string;
  shopify_product_id: string;
  title: string;
  source_order_line_count: bigint;
  sold_units: bigint | number | null;
  refunded_units: bigint | number | null;
  restocked_units: bigint | number | null;
  net_units: bigint | number | null;
  cogs_units: bigint | number | null;
  revenue: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
  cogs: Prisma.Decimal | string | number | null;
  cost_covered_units: bigint | number | null;
};

type RawIntelligenceInventoryEvidenceRow = {
  product_id: string;
  source_inventory_level_count: bigint;
  available: bigint | number | null;
  restock_lead_time_days: number;
  low_stock_threshold_units: number;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * High-volume Shopify evidence reads for the deterministic intelligence engine.
 *
 * The rule layer needs product-level economics/depletion plus current available stock. PostgreSQL
 * resolves refunds, historical unit costs, and multi-location inventory before returning compact
 * product rows instead of complete line/refund/cost/inventory histories.
 */
export class IntelligenceCommerceReadRepository {
  async getProductEvidenceAggregates(input: {
    storeId: string;
    currency: string;
    from: Date;
    to: Date;
  }): Promise<IntelligenceCommerceEvidenceRow[]> {
    const rows = await prisma.$queryRaw<RawIntelligenceCommerceEvidenceRow[]>(Prisma.sql`
      WITH scoped_orders AS (
        SELECT
          o."id",
          COALESCE(o."processedAt", o."shopifyCreatedAt") AS order_at
        FROM "Order" o
        WHERE o."storeId" = ${input.storeId}::uuid
          AND o."isTest" = FALSE
          AND o."cancelledAt" IS NULL
          AND o."currencyCode" = ${input.currency}
          AND (
            o."processedAt" BETWEEN ${input.from} AND ${input.to}
            OR (
              o."processedAt" IS NULL
              AND o."shopifyCreatedAt" BETWEEN ${input.from} AND ${input.to}
            )
          )
      ),
      scoped_lines AS (
        SELECT
          li."id",
          li."orderId",
          li."productId",
          li."variantId",
          li."quantity",
          COALESCE(li."discountedTotal", 0) AS revenue,
          scoped.order_at,
          product."shopifyProductId" AS shopify_product_id,
          product."title"
        FROM "OrderLineItem" li
        INNER JOIN scoped_orders scoped ON scoped."id" = li."orderId"
        INNER JOIN "Product" product ON product."id" = li."productId"
        WHERE li."productId" IS NOT NULL
      ),
      refund_line_totals AS (
        SELECT
          refund_line."orderLineItemId" AS order_line_item_id,
          COALESCE(SUM(refund_line."quantity"), 0) AS refunded_units,
          COALESCE(SUM(refund_line."quantity") FILTER (WHERE refund_line."restocked" = TRUE), 0) AS restocked_units,
          COALESCE(SUM(refund_line."subtotal"), 0) AS refunds
        FROM "RefundLineItem" refund_line
        INNER JOIN scoped_lines scoped ON scoped."id" = refund_line."orderLineItemId"
        GROUP BY refund_line."orderLineItemId"
      ),
      enriched_lines AS (
        SELECT
          scoped.*,
          COALESCE(refunds.refunded_units, 0) AS refunded_units,
          COALESCE(refunds.restocked_units, 0) AS restocked_units,
          COALESCE(refunds.refunds, 0) AS refunds,
          GREATEST(scoped."quantity" - COALESCE(refunds.refunded_units, 0), 0) AS net_units,
          GREATEST(scoped."quantity" - COALESCE(refunds.restocked_units, 0), 0) AS cogs_units,
          unit_cost.amount AS unit_cost
        FROM scoped_lines scoped
        LEFT JOIN refund_line_totals refunds ON refunds.order_line_item_id = scoped."id"
        LEFT JOIN LATERAL (
          SELECT cost."amount"
          FROM "VariantCost" cost
          WHERE cost."variantId" = scoped."variantId"
            AND cost."currency" = ${input.currency}
            AND cost."effectiveFrom" <= scoped.order_at
            AND (cost."effectiveUntil" IS NULL OR cost."effectiveUntil" > scoped.order_at)
          ORDER BY cost."effectiveFrom" DESC
          LIMIT 1
        ) unit_cost ON TRUE
      )
      SELECT
        enriched."productId" AS product_id,
        enriched.shopify_product_id,
        enriched."title",
        COUNT(*) AS source_order_line_count,
        COALESCE(SUM(enriched."quantity"), 0) AS sold_units,
        COALESCE(SUM(enriched.refunded_units), 0) AS refunded_units,
        COALESCE(SUM(enriched.restocked_units), 0) AS restocked_units,
        COALESCE(SUM(enriched.net_units), 0) AS net_units,
        COALESCE(SUM(enriched.cogs_units), 0) AS cogs_units,
        COALESCE(SUM(enriched.revenue), 0) AS revenue,
        COALESCE(SUM(enriched.refunds), 0) AS refunds,
        COALESCE(
          SUM(enriched.unit_cost * enriched.cogs_units) FILTER (WHERE enriched.unit_cost IS NOT NULL),
          0
        ) AS cogs,
        COALESCE(
          SUM(enriched.cogs_units) FILTER (WHERE enriched.unit_cost IS NOT NULL),
          0
        ) AS cost_covered_units
      FROM enriched_lines enriched
      GROUP BY enriched."productId", enriched.shopify_product_id, enriched."title"
      ORDER BY enriched."productId"
    `);

    return rows.map((row) => ({
      productId: row.product_id,
      shopifyProductId: row.shopify_product_id,
      title: row.title,
      sourceOrderLineCount: numeric(row.source_order_line_count),
      soldUnits: numeric(row.sold_units),
      refundedUnits: numeric(row.refunded_units),
      restockedUnits: numeric(row.restocked_units),
      netUnits: numeric(row.net_units),
      cogsUnits: numeric(row.cogs_units),
      revenue: numeric(row.revenue),
      refunds: numeric(row.refunds),
      cogs: numeric(row.cogs),
      costCoveredUnits: numeric(row.cost_covered_units),
    }));
  }

  async getInventoryEvidenceAggregates(storeId: string): Promise<IntelligenceInventoryEvidenceRow[]> {
    const rows = await prisma.$queryRaw<RawIntelligenceInventoryEvidenceRow[]>(Prisma.sql`
      SELECT
        variant."productId" AS product_id,
        COUNT(*) AS source_inventory_level_count,
        COALESCE(SUM(level."available"), 0) AS available,
        store."inventoryRestockLeadTimeDays" AS restock_lead_time_days,
        store."inventoryLowStockThresholdUnits" AS low_stock_threshold_units
      FROM "InventoryLevelCurrent" level
      INNER JOIN "InventoryItem" item ON item."id" = level."inventoryItemId"
      INNER JOIN "ProductVariant" variant ON variant."id" = item."variantId"
      INNER JOIN "Product" product ON product."id" = variant."productId"
      INNER JOIN "Location" location ON location."id" = level."locationId"
      INNER JOIN "Store" store ON store."id" = item."storeId"
      WHERE item."storeId" = ${storeId}::uuid
        AND item."deletedAt" IS NULL
        AND variant."deletedAt" IS NULL
        AND product."deletedAt" IS NULL
        AND location."deletedAt" IS NULL
        AND location."isActive" = TRUE
      GROUP BY variant."productId", store."inventoryRestockLeadTimeDays", store."inventoryLowStockThresholdUnits"
      ORDER BY variant."productId"
    `);

    return rows.map((row) => ({
      productId: row.product_id,
      sourceInventoryLevelCount: numeric(row.source_inventory_level_count),
      available: numeric(row.available),
      restockLeadTimeDays: Math.max(1, numeric(row.restock_lead_time_days)),
      lowStockThresholdUnits: Math.max(0, numeric(row.low_stock_threshold_units)),
    }));
  }
}
