import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { pixelCheckoutPurchaseReadRepository } from '../pixel/behavior/pixel-checkout-purchase.read.repository.js';

export interface IntelligenceStorefrontEvidenceRow {
  period: 'CURRENT' | 'COMPARISON';
  dimension: 'STORE' | 'PRODUCT' | 'LANDING_PAGE';
  dimensionKey: string;
  productId: string | null;
  productExternalId: string | null;
  productTitle: string | null;
  landingPageUrl: string | null;
  sourceRowCount: number;
  sessionCount: number;
  productViewSessionCount: number;
  addToCartSessionCount: number;
  cartViewSessionCount: number;
  cartViewCheckoutSessionCount: number;
  cartViewPurchaseSessionCount: number;
  checkoutStartSessionCount: number;
  checkoutStartPurchaseSessionCount: number;
  checkoutCompletedSessionCount: number;
  linkedPurchaseSessionCount: number;
}

type RawStorefrontEvidenceRow = {
  period: 'CURRENT' | 'COMPARISON';
  dimension: 'STORE' | 'PRODUCT' | 'LANDING_PAGE';
  dimension_key: string;
  product_id: string | null;
  product_external_id: string | null;
  product_title: string | null;
  landing_page_url: string | null;
  source_row_count: bigint | number;
  session_count: bigint | number | null;
  product_view_session_count: bigint | number | null;
  add_to_cart_session_count: bigint | number | null;
  cart_view_session_count: bigint | number | null;
  cart_view_checkout_session_count: bigint | number | null;
  cart_view_purchase_session_count: bigint | number | null;
  checkout_start_session_count: bigint | number | null;
  checkout_completed_session_count: bigint | number | null;
  linked_purchase_session_count: bigint | number | null;
};

function numeric(value: bigint | number | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Compact behavior aggregates used by deterministic storefront decisions. */
export class IntelligenceStorefrontReadRepository {
  async getEvidence(input: {
    storeId: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<IntelligenceStorefrontEvidenceRow[]> {
    const [rows, checkoutPurchase] = await Promise.all([
      prisma.$queryRaw<RawStorefrontEvidenceRow[]>(Prisma.sql`
        SELECT
          CASE
            WHEN behavior."bucketDate" BETWEEN ${input.currentFrom}::date AND ${input.currentTo}::date
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          behavior."dimension"::text AS dimension,
          behavior."dimensionKey" AS dimension_key,
          behavior."productId" AS product_id,
          behavior."productExternalId" AS product_external_id,
          product."title" AS product_title,
          MAX(behavior."landingPageUrl") AS landing_page_url,
          COUNT(*) AS source_row_count,
          COALESCE(SUM(behavior."sessionCount"), 0) AS session_count,
          COALESCE(SUM(behavior."productViewSessionCount"), 0) AS product_view_session_count,
          COALESCE(SUM(behavior."addToCartSessionCount"), 0) AS add_to_cart_session_count,
          COALESCE(SUM(behavior."cartViewSessionCount"), 0) AS cart_view_session_count,
          COALESCE(SUM(behavior."cartViewCheckoutSessionCount"), 0) AS cart_view_checkout_session_count,
          COALESCE(SUM(behavior."cartViewPurchaseSessionCount"), 0) AS cart_view_purchase_session_count,
          COALESCE(SUM(behavior."checkoutStartSessionCount"), 0) AS checkout_start_session_count,
          COALESCE(SUM(behavior."checkoutCompletedSessionCount"), 0) AS checkout_completed_session_count,
          COALESCE(SUM(behavior."linkedPurchaseSessionCount"), 0) AS linked_purchase_session_count
        FROM "StorefrontBehaviorDaily" behavior
        LEFT JOIN "Product" product
          ON product."id" = behavior."productId"
          AND product."storeId" = behavior."storeId"
        WHERE behavior."storeId" = ${input.storeId}::uuid
          AND behavior."dimension" IN ('STORE', 'PRODUCT', 'LANDING_PAGE')
          AND (
            behavior."bucketDate" BETWEEN ${input.currentFrom}::date AND ${input.currentTo}::date
            OR behavior."bucketDate" BETWEEN ${input.comparisonFrom}::date AND ${input.comparisonTo}::date
          )
        GROUP BY
          period,
          behavior."dimension",
          behavior."dimensionKey",
          behavior."productId",
          behavior."productExternalId",
          product."title"
        ORDER BY behavior."dimension", behavior."dimensionKey", period
      `),
      pixelCheckoutPurchaseReadRepository.getOverlapCountsForStoreDates({
        storeId: input.storeId,
        currentFrom: input.currentFrom,
        currentTo: input.currentTo,
        comparisonFrom: input.comparisonFrom,
        comparisonTo: input.comparisonTo,
      }),
    ]);

    return rows.map((row) => ({
      period: row.period,
      dimension: row.dimension,
      dimensionKey: row.dimension_key,
      productId: row.product_id,
      productExternalId: row.product_external_id,
      productTitle: row.product_title,
      landingPageUrl: row.landing_page_url,
      sourceRowCount: numeric(row.source_row_count),
      sessionCount: numeric(row.session_count),
      productViewSessionCount: numeric(row.product_view_session_count),
      addToCartSessionCount: numeric(row.add_to_cart_session_count),
      cartViewSessionCount: numeric(row.cart_view_session_count),
      cartViewCheckoutSessionCount: numeric(row.cart_view_checkout_session_count),
      cartViewPurchaseSessionCount: numeric(row.cart_view_purchase_session_count),
      checkoutStartSessionCount: numeric(row.checkout_start_session_count),
      checkoutStartPurchaseSessionCount:
        row.dimension === 'STORE'
          ? row.period === 'CURRENT'
            ? checkoutPurchase.current
            : checkoutPurchase.comparison
          : 0,
      checkoutCompletedSessionCount: numeric(row.checkout_completed_session_count),
      linkedPurchaseSessionCount: numeric(row.linked_purchase_session_count),
    }));
  }
}
