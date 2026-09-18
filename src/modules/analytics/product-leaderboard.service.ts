import { AppError } from '../../errors/app-error.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import {
  emptyProductMetrics,
  metricChanges,
  totalProductMetrics,
  type ProductMetrics,
} from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';
import {
  CommerceAnalyticsReadRepository,
  type CommerceProductEconomicsAggregateRow,
} from './commerce-analytics.read.repository.js';
import { ProductLeaderboardReadRepository } from './product-leaderboard.read.repository.js';

const MIN_COST_COVERAGE = 0.8;

export type ProductLeaderboardQuery = AnalyticsRangeQuery & { limit: number };

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;

function productMetrics(row: CommerceProductEconomicsAggregateRow): ProductMetrics {
  const netProductRevenue = Math.max(0, row.productRevenue - row.refunds);
  const costCoverage =
    row.costRelevantUnits > 0 ? row.costCoveredUnits / row.costRelevantUnits : 0;
  const cogs = costCoverage >= MIN_COST_COVERAGE ? row.rawCogs : null;

  return {
    orderCount: row.orderCount,
    soldUnits: row.soldUnits,
    refundedUnits: row.refundedUnits,
    netUnits: Math.max(0, row.soldUnits - row.refundedUnits),
    productRevenue: row.productRevenue,
    refunds: row.refunds,
    netProductRevenue,
    cogs,
    costCoverage,
    contributionBeforeAds: cogs === null ? null : netProductRevenue - cogs,
  };
}

function metricsByProduct(
  rows: CommerceProductEconomicsAggregateRow[],
  period: 'CURRENT' | 'COMPARISON',
) {
  return new Map(
    rows
      .filter((row) => row.period === period)
      .map((row) => [row.productId, productMetrics(row)] as const),
  );
}

export class ProductLeaderboardService {
  constructor(
    private readonly analyticsRepository: AnalyticsRepository = new AnalyticsRepository(),
    private readonly commerceRepository: CommerceAnalyticsReadRepository =
      new CommerceAnalyticsReadRepository(),
    private readonly productRepository: ProductLeaderboardReadRepository =
      new ProductLeaderboardReadRepository(),
  ) {}

  async read(storeId: string, query: ProductLeaderboardQuery, now = new Date()) {
    const store = await this.loadStore(storeId);
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const rows = await this.commerceRepository.getProductEconomicsAggregates({
      storeId,
      currency: store.currencyCode,
      currentFrom: windows.current.instantFrom,
      currentTo: windows.current.instantTo,
      comparisonFrom: windows.comparison.instantFrom,
      comparisonTo: windows.comparison.instantTo,
    });

    const current = metricsByProduct(rows, 'CURRENT');
    const comparison = metricsByProduct(rows, 'COMPARISON');
    const candidateIds = [...new Set([...current.keys(), ...comparison.keys()])];
    const [products, catalogProducts] = await Promise.all([
      this.productRepository.getProductsByIds(storeId, candidateIds),
      this.productRepository.getCatalogProductCount(storeId),
    ]);
    const productById = new Map(products.map((product) => [product.id, product] as const));
    const rankedIds = candidateIds
      .filter((productId) => productById.has(productId))
      .sort((leftId, rightId) => {
        const left = current.get(leftId) ?? emptyProductMetrics();
        const right = current.get(rightId) ?? emptyProductMetrics();
        return (
          right.netProductRevenue - left.netProductRevenue ||
          right.netUnits - left.netUnits ||
          right.orderCount - left.orderCount ||
          (productById.get(leftId)?.title ?? leftId).localeCompare(
            productById.get(rightId)?.title ?? rightId,
          )
        );
      });
    const validCurrent = rankedIds.map((productId) => current.get(productId) ?? emptyProductMetrics());
    const validComparison = rankedIds.map(
      (productId) => comparison.get(productId) ?? emptyProductMetrics(),
    );
    const currentTotals = totalProductMetrics(validCurrent);
    const comparisonTotals = totalProductMetrics(validComparison);

    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
      ranking: {
        scope: 'STORE_WIDE_WINDOW_ACTIVITY',
        metric: 'NET_PRODUCT_REVENUE',
        limit: query.limit,
        windowActiveProducts: rankedIds.length,
        catalogProducts,
      },
      totals: {
        current: currentTotals,
        comparison: comparisonTotals,
        change: metricChanges(currentTotals, comparisonTotals),
      },
      items: rankedIds.slice(0, query.limit).map((productId, index) => {
        const currentMetrics = current.get(productId) ?? emptyProductMetrics();
        const comparisonMetrics = comparison.get(productId) ?? emptyProductMetrics();
        return {
          rank: index + 1,
          product: productById.get(productId)!,
          current: currentMetrics,
          comparison: comparisonMetrics,
          change: metricChanges(currentMetrics, comparisonMetrics),
        };
      }),
    };
  }

  private async loadStore(storeId: string): Promise<StoreContext> {
    const store = await this.analyticsRepository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return store;
  }
}

export const productLeaderboardService = new ProductLeaderboardService();
