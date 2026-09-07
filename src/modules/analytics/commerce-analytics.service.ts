import { AppError } from '../../errors/app-error.js';
import {
  aggregateOrders,
  aggregateProducts,
  aggregateVariantUnits,
  commerceRowDate,
  emptyProductMetrics,
  metricChanges,
  numeric,
  orderDate,
  totalProductMetrics,
  type CommerceMetrics,
} from './analytics.metrics.js';
import type { AnalyticsRepository } from './analytics.repository.js';
import type {
  CommerceAnalyticsReadRepository,
  CommerceCustomerSegment,
  CommerceOrderAggregateRow,
  CommerceOrderPeriod,
} from './commerce-analytics.read.repository.js';
import { pagination, splitCommerce, splitOrders, windowResponse } from './analytics.shared.js';
import type { AnalyticsWindows } from './analytics.shared.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;
type OrderRow = Awaited<ReturnType<AnalyticsRepository['getOrders']>>[number];
type CommerceRow = Awaited<ReturnType<AnalyticsRepository['getCommerceRows']>>[number];

interface LineMetrics {
  orderCount: number;
  soldUnits: number;
  refundedUnits: number;
  netUnits: number;
  productRevenue: number;
  refunds: number;
  netProductRevenue: number;
}

function lineMetrics(rows: CommerceRow[], currency: string): LineMetrics {
  const orders = new Set<string>();
  let soldUnits = 0;
  let refundedUnits = 0;
  let productRevenue = 0;
  let refunds = 0;

  for (const row of rows) {
    if (row.order.currencyCode !== currency) continue;
    orders.add(row.order.id);
    soldUnits += row.quantity;
    refundedUnits += row.refundLines.reduce((sum, refund) => sum + refund.quantity, 0);
    productRevenue += numeric(row.discountedTotal);
    refunds += row.refundLines.reduce((sum, refund) => sum + numeric(refund.subtotal), 0);
  }

  return {
    orderCount: orders.size,
    soldUnits,
    refundedUnits,
    netUnits: Math.max(0, soldUnits - refundedUnits),
    productRevenue,
    refunds,
    netProductRevenue: Math.max(0, productRevenue - refunds),
  };
}

function dailyProduct(rows: CommerceRow[], currency: string) {
  const groups = new Map<string, CommerceRow[]>();
  for (const row of rows) {
    if (row.order.currencyCode !== currency) continue;
    const key = commerceRowDate(row).toISOString().slice(0, 10);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({ date, ...lineMetrics(values, currency) }));
}

function customerSegment(row: OrderRow): 'NEW' | 'RETURNING' | 'UNKNOWN' {
  if (!row.customerJourneyReady || row.customerOrderIndex === null) return 'UNKNOWN';
  if (row.customerOrderIndex === 1) return 'NEW';
  return row.customerOrderIndex > 1 ? 'RETURNING' : 'UNKNOWN';
}

function aggregateOrderFacts(
  rows: CommerceOrderAggregateRow[],
  period: CommerceOrderPeriod,
  segment?: CommerceCustomerSegment,
): CommerceMetrics {
  const scoped = rows.filter(
    (row) => row.period === period && (segment === undefined || row.segment === segment),
  );
  const orders = scoped.reduce((sum, row) => sum + row.orders, 0);
  const units = scoped.reduce((sum, row) => sum + row.units, 0);
  const orderValue = scoped.reduce((sum, row) => sum + row.orderValue, 0);
  const refunds = scoped.reduce((sum, row) => sum + row.refunds, 0);
  const discounts = scoped.reduce((sum, row) => sum + row.discounts, 0);
  const segmentOrders = (kind: CommerceCustomerSegment) =>
    scoped.filter((row) => row.segment === kind).reduce((sum, row) => sum + row.orders, 0);

  return {
    orders,
    units,
    orderValue,
    refunds,
    // Shopify currentTotalAmount is already the current order truth. Preserve the established
    // semantics and expose linked refunds separately rather than subtracting them twice.
    netOrderValue: orderValue,
    discounts,
    aov: orders > 0 ? orderValue / orders : null,
    newOrders: segmentOrders('NEW'),
    returningOrders: segmentOrders('RETURNING'),
    unknownCustomerOrders: segmentOrders('UNKNOWN'),
  };
}

export class CommerceAnalyticsService {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly readRepository?: CommerceAnalyticsReadRepository,
  ) {}

  private orderAggregateInput(store: StoreContext, windows: AnalyticsWindows) {
    return {
      storeId: store.id,
      currency: store.currencyCode,
      currentFrom: windows.current.instantFrom,
      currentTo: windows.current.instantTo,
      comparisonFrom: windows.comparison.instantFrom,
      comparisonTo: windows.comparison.instantTo,
    };
  }

  async summary(store: StoreContext, windows: AnalyticsWindows) {
    if (this.readRepository) {
      const rows = await this.readRepository.getOrderAggregates(
        this.orderAggregateInput(store, windows),
      );
      const current = aggregateOrderFacts(rows, 'CURRENT');
      const comparison = aggregateOrderFacts(rows, 'COMPARISON');
      return {
        current,
        comparison,
        change: metricChanges(current, comparison),
      };
    }

    // Characterization fallback used by isolated unit tests. Production injects the compact
    // SQL read repository so it never materializes the full order/refund history for totals.
    const rows = await this.repository.getOrders(
      store.id,
      windows.comparison.instantFrom,
      windows.current.instantTo,
    );
    const split = splitOrders(rows, windows, orderDate);
    const current = aggregateOrders(split.current, store.currencyCode);
    const comparison = aggregateOrders(split.comparison, store.currencyCode);

    return {
      current,
      comparison,
      change: metricChanges(current, comparison),
    };
  }

  async products(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const page = await this.repository.getProductsPage(store.id, pageNumber, limit);
    const productIds = page.items.map((product) => product.id);
    if (productIds.length === 0) {
      return {
        window: windowResponse(windows),
        currency: store.currencyCode,
        pagination: pagination(pageNumber, limit, page.total),
        items: [],
      };
    }

    const rows = await this.repository.getCommerceRows(
      store.id,
      windows.comparison.instantFrom,
      windows.current.instantTo,
      productIds,
    );
    const costs = await this.costsForRows(store.id, rows, windows);
    const split = splitCommerce(rows, windows, commerceRowDate);
    const current = aggregateProducts(split.current, costs, store.currencyCode);
    const comparison = aggregateProducts(split.comparison, costs, store.currencyCode);

    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
      pagination: pagination(pageNumber, limit, page.total),
      items: page.items.map((product) => {
        const currentMetrics = current.get(product.id) ?? emptyProductMetrics();
        const comparisonMetrics = comparison.get(product.id) ?? emptyProductMetrics();
        return {
          product,
          current: currentMetrics,
          comparison: comparisonMetrics,
          change: metricChanges(currentMetrics, comparisonMetrics),
        };
      }),
    };
  }

  async product(store: StoreContext, windows: AnalyticsWindows, productId: string) {
    const product = await this.repository.getProduct(store.id, productId);
    if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

    const rows = await this.repository.getCommerceRows(
      store.id,
      windows.comparison.instantFrom,
      windows.current.instantTo,
      [productId],
    );
    const costs = await this.costsForRows(store.id, rows, windows);
    const split = splitCommerce(rows, windows, commerceRowDate);
    const current =
      aggregateProducts(split.current, costs, store.currencyCode).get(productId) ??
      emptyProductMetrics();
    const comparison =
      aggregateProducts(split.comparison, costs, store.currencyCode).get(productId) ??
      emptyProductMetrics();

    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
      product: {
        ...product,
        collections: product.collections.map((item) => item.collection),
      },
      current,
      comparison,
      change: metricChanges(current, comparison),
      daily: dailyProduct(split.current, store.currencyCode),
    };
  }

  async collections(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const page = await this.repository.getCollectionsPage(store.id, pageNumber, limit);
    const productIds = [
      ...new Set(page.items.flatMap((collection) => collection.products.map((item) => item.productId))),
    ];
    const rows =
      productIds.length === 0
        ? []
        : await this.repository.getCommerceRows(
            store.id,
            windows.comparison.instantFrom,
            windows.current.instantTo,
            productIds,
          );
    const split = splitCommerce(rows, windows, commerceRowDate);

    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: 'SHOPIFY_ORDER_COHORT_WITH_CURRENT_COLLECTION_MEMBERSHIP',
      membershipSnapshot: 'CURRENT',
      pagination: pagination(pageNumber, limit, page.total),
      items: page.items.map((collection) => {
        const ids = new Set(collection.products.map((item) => item.productId));
        const current = lineMetrics(
          split.current.filter((row) => Boolean(row.productId && ids.has(row.productId))),
          store.currencyCode,
        );
        const comparison = lineMetrics(
          split.comparison.filter((row) => Boolean(row.productId && ids.has(row.productId))),
          store.currencyCode,
        );
        return {
          collection: {
            id: collection.id,
            shopifyCollectionId: collection.shopifyCollectionId,
            title: collection.title,
            handle: collection.handle,
            imageUrl: collection.imageUrl,
            productCount: collection.products.length,
          },
          current,
          comparison,
          change: metricChanges(current, comparison),
        };
      }),
    };
  }

  async customers(store: StoreContext, windows: AnalyticsWindows) {
    if (this.readRepository) {
      const rows = await this.readRepository.getOrderAggregates(
        this.orderAggregateInput(store, windows),
      );
      const current = aggregateOrderFacts(rows, 'CURRENT');
      const comparison = aggregateOrderFacts(rows, 'COMPARISON');
      const currentKnown = current.newOrders + current.returningOrders;
      const comparisonKnown = comparison.newOrders + comparison.returningOrders;
      const segmentPair = (kind: CommerceCustomerSegment) => {
        const segmentCurrent = aggregateOrderFacts(rows, 'CURRENT', kind);
        const segmentComparison = aggregateOrderFacts(rows, 'COMPARISON', kind);
        return {
          current: segmentCurrent,
          comparison: segmentComparison,
          change: metricChanges(segmentCurrent, segmentComparison),
        };
      };

      return {
        window: windowResponse(windows),
        currency: store.currencyCode,
        methodology: 'ORDER_CLASSIFICATION_WITHOUT_CUSTOMER_PII',
        coverage: {
          current: current.orders > 0 ? currentKnown / current.orders : 0,
          comparison: comparison.orders > 0 ? comparisonKnown / comparison.orders : 0,
        },
        total: {
          current,
          comparison,
          change: metricChanges(current, comparison),
        },
        segments: {
          new: segmentPair('NEW'),
          returning: segmentPair('RETURNING'),
          unknown: segmentPair('UNKNOWN'),
        },
      };
    }

    const rows = await this.repository.getOrders(
      store.id,
      windows.comparison.instantFrom,
      windows.current.instantTo,
    );
    const split = splitOrders(rows, windows, orderDate);
    const segment = (values: OrderRow[], kind: 'NEW' | 'RETURNING' | 'UNKNOWN') =>
      aggregateOrders(values.filter((row) => customerSegment(row) === kind), store.currencyCode);
    const current = aggregateOrders(split.current, store.currencyCode);
    const comparison = aggregateOrders(split.comparison, store.currencyCode);
    const currentKnown = current.newOrders + current.returningOrders;
    const comparisonKnown = comparison.newOrders + comparison.returningOrders;
    const segmentPair = (kind: 'NEW' | 'RETURNING' | 'UNKNOWN') => {
      const segmentCurrent = segment(split.current, kind);
      const segmentComparison = segment(split.comparison, kind);
      return {
        current: segmentCurrent,
        comparison: segmentComparison,
        change: metricChanges(segmentCurrent, segmentComparison),
      };
    };

    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: 'ORDER_CLASSIFICATION_WITHOUT_CUSTOMER_PII',
      coverage: {
        current: current.orders > 0 ? currentKnown / current.orders : 0,
        comparison: comparison.orders > 0 ? comparisonKnown / comparison.orders : 0,
      },
      total: {
        current,
        comparison,
        change: metricChanges(current, comparison),
      },
      segments: {
        new: segmentPair('NEW'),
        returning: segmentPair('RETURNING'),
        unknown: segmentPair('UNKNOWN'),
      },
    };
  }

  async profitabilityBase(store: StoreContext, windows: AnalyticsWindows) {
    const rows = await this.repository.getCommerceRows(
      store.id,
      windows.comparison.instantFrom,
      windows.current.instantTo,
    );
    const costs = await this.costsForRows(store.id, rows, windows);
    const split = splitCommerce(rows, windows, commerceRowDate);
    const current = totalProductMetrics(
      aggregateProducts(split.current, costs, store.currencyCode).values(),
    );
    const comparison = totalProductMetrics(
      aggregateProducts(split.comparison, costs, store.currencyCode).values(),
    );
    return { current, comparison };
  }

  async inventory(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const page = await this.repository.getInventoryPage(store.id, pageNumber, limit);
    const variantIds = page.items.map((item) => item.variant.id);
    const salesRows = await this.repository.getVariantSalesRows(
      store.id,
      variantIds,
      windows.current.instantFrom,
      windows.current.instantTo,
    );
    const units = aggregateVariantUnits(salesRows);
    const trusted = store.inventoryIntelligenceMode === 'TRUSTED';

    return {
      window: windowResponse(windows),
      inventoryMode: store.inventoryIntelligenceMode,
      pagination: pagination(pageNumber, limit, page.total),
      items: page.items.map((item) => {
        const available = item.currentLevels.reduce((sum, level) => sum + level.available, 0);
        const incoming = item.currentLevels.reduce((sum, level) => sum + level.incoming, 0);
        const committed = item.currentLevels.reduce((sum, level) => sum + level.committed, 0);
        const onHand = item.currentLevels.reduce((sum, level) => sum + level.onHand, 0);
        const unitsSold = units.get(item.variant.id) ?? 0;
        const unitsPerDay = unitsSold / windows.days;

        return {
          inventoryItemId: item.id,
          product: item.variant.product,
          variant: {
            id: item.variant.id,
            shopifyVariantId: item.variant.shopifyVariantId,
            title: item.variant.title,
            displayName: item.variant.displayName,
            sku: item.sku,
          },
          tracked: item.tracked,
          available,
          incoming,
          committed,
          onHand,
          unitsSoldInWindow: unitsSold,
          unitsPerDay,
          daysCover:
            trusted && item.tracked && unitsPerDay > 0
              ? Math.max(0, available) / unitsPerDay
              : null,
          locations: item.currentLevels,
        };
      }),
    };
  }

  private async costsForRows(storeId: string, rows: CommerceRow[], windows: AnalyticsWindows) {
    const variantIds = [
      ...new Set(rows.map((row) => row.variantId).filter((id): id is string => Boolean(id))),
    ];
    return this.repository.getVariantCosts(
      storeId,
      variantIds,
      windows.comparison.instantFrom,
      windows.current.instantTo,
    );
  }
}
