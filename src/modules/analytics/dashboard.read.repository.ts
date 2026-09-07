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

export type DashboardRecentOrder = {
  id: string;
  name: string;
  shopifyCreatedAt: Date;
  processedAt: Date | null;
  currencyCode: string;
  currentTotalAmount: number;
  currentQuantity: number;
};

/** Compact reads used only by the Overview dashboard surface. */
export class DashboardReadRepository {
  async getRecentOrders(storeId: string, limit = 6): Promise<DashboardRecentOrder[]> {
    const rows = await prisma.$queryRaw<RawRecentOrder[]>(Prisma.sql`
      SELECT
        o."id",
        o."name",
        o."shopifyCreatedAt" AS shopify_created_at,
        o."processedAt" AS processed_at,
        o."currencyCode" AS currency_code,
        o."currentTotalAmount" AS current_total_amount,
        COALESCE(SUM(li."currentQuantity"), 0) AS current_quantity
      FROM "Order" o
      LEFT JOIN "OrderLineItem" li ON li."orderId" = o."id"
      WHERE o."storeId" = ${storeId}::uuid
        AND o."isTest" = FALSE
      GROUP BY
        o."id",
        o."name",
        o."shopifyCreatedAt",
        o."processedAt",
        o."currencyCode",
        o."currentTotalAmount"
      ORDER BY o."shopifyCreatedAt" DESC, o."id" DESC
      LIMIT ${limit}
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
}
