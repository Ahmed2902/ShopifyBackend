import type { AnalyticsRepository } from './analytics.repository.js';

type MetaRow = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>[number];
type OrderRow = Awaited<ReturnType<AnalyticsRepository['getOrders']>>[number];
type CommerceRow = Awaited<ReturnType<AnalyticsRepository['getCommerceRows']>>[number];
type CostRow = Awaited<ReturnType<AnalyticsRepository['getVariantCosts']>>[number];
type VariantSalesRow = Awaited<ReturnType<AnalyticsRepository['getVariantSalesRows']>>[number];
type MetaAction = MetaRow['actions'][number];

const PURCHASE_ACTION_PRIORITY = [
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
  'purchase',
];
const MIN_COST_COVERAGE = 0.8;

export interface MetaMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  providerRoas: number | null;
  cpa: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  averageDailyFrequency: number | null;
}

export interface CommerceMetrics {
  orders: number;
  units: number;
  orderValue: number;
  refunds: number;
  netOrderValue: number;
  discounts: number;
  aov: number | null;
  newOrders: number;
  returningOrders: number;
  unknownCustomerOrders: number;
}

export interface ProductMetrics {
  orderCount: number;
  soldUnits: number;
  refundedUnits: number;
  netUnits: number;
  productRevenue: number;
  refunds: number;
  netProductRevenue: number;
  cogs: number | null;
  costCoverage: number;
  contributionBeforeAds: number | null;
}

interface MetaAccumulator {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
}

interface ProductAccumulator {
  orders: Set<string>;
  soldUnits: number;
  refundedUnits: number;
  productRevenue: number;
  refunds: number;
  cogs: number;
  costCoveredUnits: number;
  costRelevantUnits: number;
}

export function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function percentChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  if (comparison === 0) return current === 0 ? 0 : null;
  return (current - comparison) / Math.abs(comparison);
}

export function metricChanges<K extends string>(
  current: Record<K, number | null>,
  comparison: Record<K, number | null>,
): Record<K, number | null> {
  const changes = {} as Record<K, number | null>;
  for (const key of Object.keys(current) as K[]) {
    changes[key] = percentChange(current[key], comparison[key]);
  }
  return changes;
}

function purchaseRank(actionType: string): number {
  const exact = PURCHASE_ACTION_PRIORITY.indexOf(actionType);
  if (exact >= 0) return exact;
  return actionType.toLowerCase().includes('purchase') ? PURCHASE_ACTION_PRIORITY.length : 100;
}

function selectedPurchaseValue(actions: MetaAction[], kind: 'ACTION' | 'ACTION_VALUE'): number {
  const candidates = actions.filter(
    (action) => action.kind === kind && purchaseRank(action.actionType) < 100,
  );
  if (candidates.length === 0) return 0;

  const bestRank = Math.min(...candidates.map((action) => purchaseRank(action.actionType)));
  const selectedType = candidates.find((action) => purchaseRank(action.actionType) === bestRank)?.actionType;
  if (!selectedType) return 0;
  return candidates
    .filter((action) => action.actionType === selectedType)
    .reduce((sum, action) => sum + numeric(action.value), 0);
}

function selectedPurchaseRoas(actions: MetaAction[]): number | null {
  for (const kind of ['WEBSITE_PURCHASE_ROAS', 'PURCHASE_ROAS'] as const) {
    const candidates = actions.filter(
      (action) => action.kind === kind && purchaseRank(action.actionType) < 100,
    );
    if (candidates.length === 0) continue;

    const bestRank = Math.min(...candidates.map((action) => purchaseRank(action.actionType)));
    const selectedType = candidates.find((action) => purchaseRank(action.actionType) === bestRank)?.actionType;
    if (!selectedType) continue;
    const values = candidates
      .filter((action) => action.actionType === selectedType)
      .map((action) => numeric(action.value))
      .filter((value) => value > 0);
    if (values.length > 0) return Math.max(...values);
  }
  return null;
}

function emptyMeta(): MetaAccumulator {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    purchases: 0,
    purchaseValue: 0,
    weightedFrequency: 0,
  };
}

function addMeta(target: MetaAccumulator, row: MetaRow): void {
  const spend = numeric(row.spend);
  const impressions = numeric(row.impressions);
  const frequency = row.frequency === null ? null : numeric(row.frequency);
  const directValue = selectedPurchaseValue(row.actions, 'ACTION_VALUE');
  const fallbackRoas = selectedPurchaseRoas(row.actions);

  target.spend += spend;
  target.impressions += impressions;
  target.clicks += numeric(row.clicks);
  target.purchases += selectedPurchaseValue(row.actions, 'ACTION');
  target.purchaseValue += directValue > 0 ? directValue : spend * (fallbackRoas ?? 0);
  if (frequency !== null && impressions > 0) target.weightedFrequency += frequency * impressions;
}

function finishMeta(value: MetaAccumulator): MetaMetrics {
  return {
    spend: value.spend,
    impressions: value.impressions,
    clicks: value.clicks,
    purchases: value.purchases,
    purchaseValue: value.purchaseValue,
    providerRoas: value.spend > 0 ? value.purchaseValue / value.spend : null,
    cpa: value.purchases > 0 ? value.spend / value.purchases : null,
    ctr: value.impressions > 0 ? value.clicks / value.impressions : null,
    cpc: value.clicks > 0 ? value.spend / value.clicks : null,
    cpm: value.impressions > 0 ? (value.spend / value.impressions) * 1_000 : null,
    averageDailyFrequency:
      value.impressions > 0 ? value.weightedFrequency / value.impressions : null,
  };
}

export function emptyMetaMetrics(): MetaMetrics {
  return finishMeta(emptyMeta());
}

export function aggregateMeta(rows: MetaRow[]): MetaMetrics {
  const total = emptyMeta();
  for (const row of rows) addMeta(total, row);
  return finishMeta(total);
}

export function aggregateMetaBy(
  rows: MetaRow[],
  entityId: (row: MetaRow) => string | null,
): Map<string, MetaMetrics> {
  const groups = new Map<string, MetaAccumulator>();
  for (const row of rows) {
    const id = entityId(row);
    if (!id) continue;
    const value = groups.get(id) ?? emptyMeta();
    addMeta(value, row);
    groups.set(id, value);
  }
  return new Map([...groups.entries()].map(([id, value]) => [id, finishMeta(value)]));
}

export function orderDate(row: Pick<OrderRow, 'processedAt' | 'shopifyCreatedAt'>): Date {
  return row.processedAt ?? row.shopifyCreatedAt;
}

export function commerceRowDate(row: CommerceRow): Date {
  return row.order.processedAt ?? row.order.shopifyCreatedAt;
}

export function aggregateOrders(rows: OrderRow[], currency: string): CommerceMetrics {
  let units = 0;
  let orderValue = 0;
  let refunds = 0;
  let discounts = 0;
  let newOrders = 0;
  let returningOrders = 0;
  let unknownCustomerOrders = 0;
  let orders = 0;

  for (const row of rows) {
    if (row.currencyCode !== currency) continue;
    orders += 1;
    units += row.currentSubtotalLineItemsQuantity ?? 0;
    orderValue += numeric(row.currentTotalAmount);
    discounts += numeric(row.currentTotalDiscountsAmount);
    refunds += row.refunds
      .filter((refund) => !refund.currencyCode || refund.currencyCode === currency)
      .reduce((sum, refund) => sum + numeric(refund.totalRefunded), 0);

    if (!row.customerJourneyReady || row.customerOrderIndex === null) {
      unknownCustomerOrders += 1;
    } else if (row.customerOrderIndex === 1) {
      newOrders += 1;
    } else if (row.customerOrderIndex > 1) {
      returningOrders += 1;
    } else {
      unknownCustomerOrders += 1;
    }
  }

  return {
    orders,
    units,
    orderValue,
    refunds,
    netOrderValue: orderValue,
    discounts,
    aov: orders > 0 ? orderValue / orders : null,
    newOrders,
    returningOrders,
    unknownCustomerOrders,
  };
}

function costAt(costs: CostRow[], variantId: string, at: Date, currency: string): number | null {
  const matching = costs
    .filter(
      (cost) =>
        cost.variantId === variantId &&
        cost.currency === currency &&
        cost.effectiveFrom <= at &&
        (cost.effectiveUntil === null || cost.effectiveUntil > at),
    )
    .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime());
  return matching.length > 0 ? numeric(matching[0]!.amount) : null;
}

export function aggregateProducts(
  rows: CommerceRow[],
  costs: CostRow[],
  currency: string,
): Map<string, ProductMetrics> {
  const groups = new Map<string, ProductAccumulator>();

  for (const row of rows) {
    if (!row.productId || row.order.currencyCode !== currency) continue;
    const value = groups.get(row.productId) ?? {
      orders: new Set<string>(),
      soldUnits: 0,
      refundedUnits: 0,
      productRevenue: 0,
      refunds: 0,
      cogs: 0,
      costCoveredUnits: 0,
      costRelevantUnits: 0,
    };
    const refundedUnits = row.refundLines.reduce((sum, refund) => sum + refund.quantity, 0);
    const restockedUnits = row.refundLines
      .filter((refund) => refund.restocked)
      .reduce((sum, refund) => sum + refund.quantity, 0);
    const costRelevantUnits = Math.max(0, row.quantity - restockedUnits);

    value.orders.add(row.order.id);
    value.soldUnits += row.quantity;
    value.refundedUnits += refundedUnits;
    value.productRevenue += numeric(row.discountedTotal);
    value.refunds += row.refundLines.reduce((sum, refund) => sum + numeric(refund.subtotal), 0);
    value.costRelevantUnits += costRelevantUnits;

    if (row.variantId && costRelevantUnits > 0) {
      const unitCost = costAt(costs, row.variantId, commerceRowDate(row), currency);
      if (unitCost !== null) {
        value.cogs += unitCost * costRelevantUnits;
        value.costCoveredUnits += costRelevantUnits;
      }
    }
    groups.set(row.productId, value);
  }

  return new Map(
    [...groups.entries()].map(([productId, value]) => {
      const netProductRevenue = Math.max(0, value.productRevenue - value.refunds);
      const costCoverage =
        value.costRelevantUnits > 0 ? value.costCoveredUnits / value.costRelevantUnits : 0;
      const cogs = costCoverage >= MIN_COST_COVERAGE ? value.cogs : null;
      return [
        productId,
        {
          orderCount: value.orders.size,
          soldUnits: value.soldUnits,
          refundedUnits: value.refundedUnits,
          netUnits: Math.max(0, value.soldUnits - value.refundedUnits),
          productRevenue: value.productRevenue,
          refunds: value.refunds,
          netProductRevenue,
          cogs,
          costCoverage,
          contributionBeforeAds: cogs === null ? null : netProductRevenue - cogs,
        },
      ];
    }),
  );
}

export function emptyProductMetrics(): ProductMetrics {
  return {
    orderCount: 0,
    soldUnits: 0,
    refundedUnits: 0,
    netUnits: 0,
    productRevenue: 0,
    refunds: 0,
    netProductRevenue: 0,
    cogs: null,
    costCoverage: 0,
    contributionBeforeAds: null,
  };
}

export function aggregateVariantUnits(rows: VariantSalesRow[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const row of rows) {
    if (!row.variantId) continue;
    const restocked = row.refundLines
      .filter((refund) => refund.restocked)
      .reduce((sum, refund) => sum + refund.quantity, 0);
    const inventoryConsumed = Math.max(0, row.quantity - restocked);
    units.set(row.variantId, (units.get(row.variantId) ?? 0) + inventoryConsumed);
  }
  return units;
}

export function totalProductMetrics(products: Iterable<ProductMetrics>): ProductMetrics {
  let orderCount = 0;
  let soldUnits = 0;
  let refundedUnits = 0;
  let productRevenue = 0;
  let refunds = 0;
  let cogs = 0;
  let coveredRevenueWeight = 0;
  let revenueWeight = 0;
  let hasCogs = true;

  for (const product of products) {
    orderCount += product.orderCount;
    soldUnits += product.soldUnits;
    refundedUnits += product.refundedUnits;
    productRevenue += product.productRevenue;
    refunds += product.refunds;
    revenueWeight += product.netProductRevenue;
    coveredRevenueWeight += product.netProductRevenue * product.costCoverage;
    if (product.cogs === null) hasCogs = false;
    else cogs += product.cogs;
  }

  const netProductRevenue = Math.max(0, productRevenue - refunds);
  const costCoverage = revenueWeight > 0 ? coveredRevenueWeight / revenueWeight : 0;
  const usableCogs = hasCogs && costCoverage >= MIN_COST_COVERAGE ? cogs : null;
  return {
    orderCount,
    soldUnits,
    refundedUnits,
    netUnits: Math.max(0, soldUnits - refundedUnits),
    productRevenue,
    refunds,
    netProductRevenue,
    cogs: usableCogs,
    costCoverage,
    contributionBeforeAds: usableCogs === null ? null : netProductRevenue - usableCogs,
  };
}
