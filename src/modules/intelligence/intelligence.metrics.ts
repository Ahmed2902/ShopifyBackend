import type {
  IntelligenceCommerceEvidenceRow,
  IntelligenceInventoryEvidenceRow,
} from './intelligence-commerce.read.repository.js';
import type { IntelligenceRepository } from './intelligence.repository.js';
import type {
  CampaignEvidence,
  CreativeEvidence,
  HistoricalMetrics,
  ProductEvidence,
} from './intelligence.types.js';

type MetaRow = Awaited<ReturnType<IntelligenceRepository['getMetaEvidenceRows']>>[number];
type CommerceRow = Awaited<ReturnType<IntelligenceRepository['getCommerceRows']>>[number];
type CostRow = Awaited<ReturnType<IntelligenceRepository['getVariantCosts']>>[number];
type MappingRow = Awaited<ReturnType<IntelligenceRepository['getActiveProductMappings']>>[number];
type InventoryRow = Awaited<ReturnType<IntelligenceRepository['getInventoryLevels']>>[number];

type MetaAction = MetaRow['actions'][number];

interface MetaAccumulator {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
}

interface EntityIdentity {
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string;
}

interface EntityAccumulator extends EntityIdentity {
  current: MetaAccumulator;
  comparison: MetaAccumulator;
}

const PURCHASE_ACTION_PRIORITY = [
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
  'purchase',
];

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyMetaAccumulator(): MetaAccumulator {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    purchases: 0,
    purchaseValue: 0,
    weightedFrequency: 0,
  };
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
    .reduce((sum, action) => sum + number(action.value), 0);
}

function selectedPurchaseRoas(actions: MetaAction[]): number | null {
  for (const kind of ['WEBSITE_PURCHASE_ROAS', 'PURCHASE_ROAS'] as const) {
    const candidates = actions.filter(
      (action) => String(action.kind) === kind && purchaseRank(action.actionType) < 100,
    );
    if (candidates.length === 0) continue;

    const bestRank = Math.min(...candidates.map((action) => purchaseRank(action.actionType)));
    const selectedType = candidates.find((action) => purchaseRank(action.actionType) === bestRank)?.actionType;
    if (!selectedType) continue;
    const values = candidates
      .filter((action) => action.actionType === selectedType)
      .map((action) => number(action.value))
      .filter((value) => value > 0);
    if (values.length > 0) return Math.max(...values);
  }
  return null;
}

function addMetaRow(target: MetaAccumulator, row: MetaRow): void {
  const spend = number(row.spend);
  const impressions = Number(row.impressions);
  const clicks = Number(row.clicks);
  const purchases = selectedPurchaseValue(row.actions, 'ACTION');
  const directPurchaseValue = selectedPurchaseValue(row.actions, 'ACTION_VALUE');
  const fallbackRoas = selectedPurchaseRoas(row.actions);
  const purchaseValue = directPurchaseValue > 0 ? directPurchaseValue : spend * (fallbackRoas ?? 0);
  const frequency = row.frequency === null ? null : number(row.frequency);

  target.spend += spend;
  target.impressions += Number.isFinite(impressions) ? impressions : 0;
  target.clicks += Number.isFinite(clicks) ? clicks : 0;
  target.purchases += purchases;
  target.purchaseValue += purchaseValue;
  if (frequency !== null && impressions > 0) target.weightedFrequency += frequency * impressions;
}

function finishMetaMetrics(value: MetaAccumulator): HistoricalMetrics {
  return {
    spend: value.spend,
    impressions: value.impressions,
    // Reach is not additive across ad-level daily rows, so period reach is deliberately suppressed.
    reach: null,
    clicks: value.clicks,
    purchases: value.purchases,
    purchaseValue: value.purchaseValue,
    roas: value.spend > 0 ? value.purchaseValue / value.spend : null,
    cpa: value.purchases > 0 ? value.spend / value.purchases : null,
    ctr: value.impressions > 0 ? value.clicks / value.impressions : null,
    cpc: value.clicks > 0 ? value.spend / value.clicks : null,
    cpm: value.impressions > 0 ? (value.spend / value.impressions) * 1_000 : null,
    frequency: value.impressions > 0 ? value.weightedFrequency / value.impressions : null,
  };
}

function groupMetaEvidence(
  rows: MetaRow[],
  currentStart: Date,
  currentEnd: Date,
  comparisonStart: Date,
  comparisonEnd: Date,
  identity: (row: MetaRow) => EntityIdentity | null,
): Array<{
  identity: EntityIdentity;
  current: HistoricalMetrics;
  comparison: HistoricalMetrics;
  spendShare: number;
}> {
  const groups = new Map<string, EntityAccumulator>();
  const currentSpendByCurrency = new Map<string, number>();

  for (const row of rows) {
    const entity = identity(row);
    if (!entity) continue;
    const key = `${entity.currency}:${entity.entityId}`;
    const group = groups.get(key) ?? {
      ...entity,
      current: emptyMetaAccumulator(),
      comparison: emptyMetaAccumulator(),
    };
    groups.set(key, group);

    if (row.date >= currentStart && row.date <= currentEnd) {
      addMetaRow(group.current, row);
      currentSpendByCurrency.set(
        entity.currency,
        (currentSpendByCurrency.get(entity.currency) ?? 0) + number(row.spend),
      );
    } else if (row.date >= comparisonStart && row.date <= comparisonEnd) {
      addMetaRow(group.comparison, row);
    }
  }

  return [...groups.values()].map((group) => {
    const current = finishMetaMetrics(group.current);
    const totalSpend = currentSpendByCurrency.get(group.currency) ?? 0;
    return {
      identity: group,
      current,
      comparison: finishMetaMetrics(group.comparison),
      spendShare: totalSpend > 0 ? current.spend / totalSpend : 0,
    };
  });
}

export function buildCampaignEvidence(
  rows: MetaRow[],
  currentStart: Date,
  currentEnd: Date,
  comparisonStart: Date,
  comparisonEnd: Date,
): CampaignEvidence[] {
  return groupMetaEvidence(
    rows,
    currentStart,
    currentEnd,
    comparisonStart,
    comparisonEnd,
    (row) =>
      row.campaign
        ? {
            entityId: row.campaign.id,
            externalEntityId: row.campaign.metaCampaignId,
            name: row.campaign.name,
            currency: row.accountCurrency,
          }
        : null,
  ).map((group) => ({
    ...group.identity,
    start: currentStart,
    end: currentEnd,
    current: group.current,
    comparison: group.comparison,
    spendShare: group.spendShare,
  }));
}

export function buildCreativeEvidence(
  rows: MetaRow[],
  currentStart: Date,
  currentEnd: Date,
  comparisonStart: Date,
  comparisonEnd: Date,
): CreativeEvidence[] {
  return groupMetaEvidence(
    rows,
    currentStart,
    currentEnd,
    comparisonStart,
    comparisonEnd,
    (row) => {
      const creative = row.ad?.creative;
      if (!creative) return null;
      return {
        entityId: creative.id,
        externalEntityId: creative.metaCreativeId,
        name: creative.name ?? creative.title ?? row.ad?.name ?? creative.metaCreativeId,
        currency: row.accountCurrency,
      };
    },
  ).map((group) => ({
    ...group.identity,
    start: currentStart,
    end: currentEnd,
    current: group.current,
    comparison: group.comparison,
    spendShare: group.spendShare,
  }));
}

interface ProductAggregate {
  entityId: string;
  externalEntityId: string;
  name: string;
  revenue: number;
  refunds: number;
  units: number;
  cogsUnits: number;
  cogs: number;
  costCoveredUnits: number;
}

interface ExactProductMapping {
  productId: string;
  confidence: number;
  product: MappingRow['product'];
}

interface ProductEvidenceContext {
  mappings: MappingRow[];
  metaRows: MetaRow[];
  storeCurrency: string;
  inventoryTrusted: boolean;
  windowDays: number;
}

type ProductStockRow = { productId: string; available: number };

function rawProductStock(rows: InventoryRow[]): ProductStockRow[] {
  return rows.map((row) => ({
    productId: row.inventoryItem.variant.productId,
    available: row.available,
  }));
}

function compactProductStock(rows: IntelligenceInventoryEvidenceRow[]): ProductStockRow[] {
  return rows.map((row) => ({ productId: row.productId, available: row.available }));
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
  return matching.length > 0 ? number(matching[0]!.amount) : null;
}

function exactProductMappings(mappings: MappingRow[]): Map<string, ExactProductMapping> {
  const byAd = new Map<string, MappingRow[]>();
  for (const mapping of mappings) {
    const rows = byAd.get(mapping.metaAdId) ?? [];
    rows.push(mapping);
    byAd.set(mapping.metaAdId, rows);
  }

  const exact = new Map<string, ExactProductMapping>();
  for (const [adId, rows] of byAd) {
    const confirmed = rows.filter((row) => row.isMerchantConfirmed);
    const candidates =
      confirmed.length > 0
        ? confirmed
        : rows.filter((row) => number(row.confidence) >= 0.7);
    if (candidates.length === 0) continue;

    const productIds = new Set(candidates.map((row) => row.productId));
    if (productIds.size !== 1) continue;

    exact.set(adId, {
      productId: candidates[0]!.productId,
      confidence: confirmed.length > 0
        ? 1
        : Math.max(...candidates.map((row) => number(row.confidence))),
      product: candidates[0]!.product,
    });
  }
  return exact;
}

function finishProductEvidence(
  products: Map<string, ProductAggregate>,
  input: ProductEvidenceContext,
  stockRows: ProductStockRow[],
) {
  const exactMappings = exactProductMappings(input.mappings);
  for (const mapping of exactMappings.values()) {
    if (products.has(mapping.productId)) continue;
    products.set(mapping.productId, {
      entityId: mapping.product.id,
      externalEntityId: mapping.product.shopifyProductId,
      name: mapping.product.title,
      revenue: 0,
      refunds: 0,
      units: 0,
      cogsUnits: 0,
      cogs: 0,
      costCoveredUnits: 0,
    });
  }

  const totalRevenue = [...products.values()].reduce(
    (sum, product) => sum + Math.max(0, product.revenue - product.refunds),
    0,
  );
  const productMappingConfidence = new Map<string, number[]>();
  for (const mapping of exactMappings.values()) {
    const values = productMappingConfidence.get(mapping.productId) ?? [];
    values.push(mapping.confidence);
    productMappingConfidence.set(mapping.productId, values);
  }

  const adMetrics = new Map<string, MetaAccumulator>();
  let totalMetaSpend = 0;
  let suppressedMetaSpend = 0;
  for (const row of input.metaRows) {
    const spend = number(row.spend);
    if (row.accountCurrency !== input.storeCurrency) {
      suppressedMetaSpend += spend;
      continue;
    }
    totalMetaSpend += spend;
    if (!row.ad) continue;
    const aggregate = adMetrics.get(row.ad.id) ?? emptyMetaAccumulator();
    addMetaRow(aggregate, row);
    adMetrics.set(row.ad.id, aggregate);
  }

  const paidByProduct = new Map<
    string,
    { spend: number; impressions: number; providerValue: number; weightedConfidence: number }
  >();
  let exactMappedSpend = 0;
  for (const [adId, metrics] of adMetrics) {
    const mapping = exactMappings.get(adId);
    if (!mapping) continue;
    exactMappedSpend += metrics.spend;
    const current = paidByProduct.get(mapping.productId) ?? {
      spend: 0,
      impressions: 0,
      providerValue: 0,
      weightedConfidence: 0,
    };
    current.spend += metrics.spend;
    current.impressions += metrics.impressions;
    current.providerValue += metrics.purchaseValue;
    current.weightedConfidence += metrics.spend * mapping.confidence;
    paidByProduct.set(mapping.productId, current);
  }

  const stockByProduct = new Map<string, number>();
  for (const row of stockRows) {
    stockByProduct.set(
      row.productId,
      (stockByProduct.get(row.productId) ?? 0) + row.available,
    );
  }

  const mappingCoverage = totalMetaSpend > 0 ? exactMappedSpend / totalMetaSpend : 0;
  const evidence: ProductEvidence[] = [...products.values()].map((product) => {
    const netRevenue = Math.max(0, product.revenue - product.refunds);
    const paid = paidByProduct.get(product.entityId) ?? {
      spend: 0,
      impressions: 0,
      providerValue: 0,
      weightedConfidence: 0,
    };
    const confidenceValues = productMappingConfidence.get(product.entityId) ?? [];
    const mappingConfidence =
      paid.spend > 0
        ? paid.weightedConfidence / paid.spend
        : confidenceValues.length > 0
          ? Math.max(...confidenceValues)
          : 0;
    const costCoverage = product.cogsUnits > 0 ? product.costCoveredUnits / product.cogsUnits : 0;
    const contributionBeforeAds = costCoverage >= 0.8 ? netRevenue - product.cogs : null;
    const contributionAfterAds =
      contributionBeforeAds === null ? null : contributionBeforeAds - paid.spend;
    const stockAvailable = stockByProduct.get(product.entityId) ?? null;
    const recentUnitsPerDay =
      product.cogsUnits > 0 ? product.cogsUnits / Math.max(1, input.windowDays) : null;
    const daysCover =
      stockAvailable !== null && recentUnitsPerDay !== null && recentUnitsPerDay > 0
        ? Math.max(0, stockAvailable) / recentUnitsPerDay
        : null;

    return {
      entityId: product.entityId,
      externalEntityId: product.externalEntityId,
      name: product.name,
      currency: input.storeCurrency,
      revenue: product.revenue,
      netRevenue,
      units: product.units,
      revenueShare: totalRevenue > 0 ? netRevenue / totalRevenue : 0,
      mappedMetaSpend: paid.spend,
      mappedImpressions: paid.impressions,
      mappedSpendShare: totalMetaSpend > 0 ? paid.spend / totalMetaSpend : 0,
      mappedProviderValue: paid.providerValue,
      providerRoas: paid.spend > 0 ? paid.providerValue / paid.spend : null,
      mappingConfidence,
      mappingCoverage,
      contributionBeforeAds,
      contributionAfterAds,
      costCoverage,
      inventoryTrusted: input.inventoryTrusted,
      stockAvailable,
      recentUnitsPerDay,
      daysCover,
    };
  });

  return {
    products: evidence,
    totalMetaSpend,
    exactMappedSpend,
    mappingCoverage,
    suppressedMetaSpend,
  };
}

/** Raw characterization path retained for unit tests and DB parity checks. */
export function buildProductEvidence(input: ProductEvidenceContext & {
  commerceRows: CommerceRow[];
  costRows: CostRow[];
  inventoryRows: InventoryRow[];
}) {
  const products = new Map<string, ProductAggregate>();
  for (const row of input.commerceRows) {
    if (!row.product || !row.productId || row.order.currencyCode !== input.storeCurrency) continue;
    const refunds = row.refundLines.reduce((sum, refund) => sum + number(refund.subtotal), 0);
    const refundedUnits = row.refundLines.reduce((sum, refund) => sum + refund.quantity, 0);
    const restockedUnits = row.refundLines.reduce(
      (sum, refund) => sum + (refund.restocked ? refund.quantity : 0),
      0,
    );
    const netUnits = Math.max(0, row.quantity - refundedUnits);
    const cogsUnits = Math.max(0, row.quantity - restockedUnits);
    const revenue = number(row.discountedTotal);
    const aggregate = products.get(row.productId) ?? {
      entityId: row.product.id,
      externalEntityId: row.product.shopifyProductId,
      name: row.product.title,
      revenue: 0,
      refunds: 0,
      units: 0,
      cogsUnits: 0,
      cogs: 0,
      costCoveredUnits: 0,
    };
    aggregate.revenue += revenue;
    aggregate.refunds += refunds;
    aggregate.units += netUnits;
    aggregate.cogsUnits += cogsUnits;

    if (row.variantId && cogsUnits > 0) {
      const unitCost = costAt(
        input.costRows,
        row.variantId,
        row.order.processedAt ?? row.order.shopifyCreatedAt,
        input.storeCurrency,
      );
      if (unitCost !== null) {
        aggregate.cogs += unitCost * cogsUnits;
        aggregate.costCoveredUnits += cogsUnits;
      }
    }
    products.set(row.productId, aggregate);
  }

  return finishProductEvidence(products, input, rawProductStock(input.inventoryRows));
}

export function buildProductEvidenceFromAggregates(input: ProductEvidenceContext & {
  commerceRows: IntelligenceCommerceEvidenceRow[];
  inventoryRows: IntelligenceInventoryEvidenceRow[];
}) {
  const products = new Map<string, ProductAggregate>();
  for (const row of input.commerceRows) {
    products.set(row.productId, {
      entityId: row.productId,
      externalEntityId: row.shopifyProductId,
      name: row.title,
      revenue: row.revenue,
      refunds: row.refunds,
      units: row.netUnits,
      cogsUnits: row.cogsUnits,
      cogs: row.cogs,
      costCoveredUnits: row.costCoveredUnits,
    });
  }
  return finishProductEvidence(products, input, compactProductStock(input.inventoryRows));
}
