import { AppError } from '../../errors/app-error.js';
import {
  unifiedAdvertisingScopeService,
  type UnifiedAdvertisingScopeService,
} from '../advertising/unified-advertising-scope.service.js';
import {
  UnifiedAdvertisingRepository,
  type UnifiedAdvertisingAccountRow,
  type UnifiedAdvertisingMetricRow,
  type UnifiedAdvertisingPeriod,
  type UnifiedAdvertisingProvider,
} from '../advertising/unified-advertising.repository.js';
import type {
  UnifiedAdvertisingListQuery,
  UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';
import { IntelligenceCommerceReadRepository } from '../intelligence/intelligence-commerce.read.repository.js';
import { IntelligenceContextReadRepository } from '../intelligence/intelligence-context.read.repository.js';
import { IntelligenceStorefrontReadRepository } from '../intelligence/intelligence-storefront.read.repository.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { percentChange } from './analytics.metrics.js';
import { CommerceAnalyticsReadRepository } from './commerce-analytics.read.repository.js';
import { pagination } from './analytics.shared.js';
import {
  UnifiedProductAdsRepository,
  type UnifiedMappingAccountingRow,
  type UnifiedMappingResolutionRow,
  type UnifiedProductAdMetricRow,
  type UnifiedProductMappingRow,
} from './unified-product-ads.repository.js';

const MIN_AUTOMATIC_MAPPING_CONFIDENCE = 0.7;
const MIN_COST_COVERAGE = 0.8;

type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
type MappingResolution = UnifiedMappingResolutionRow;

type ProductCommerce = {
  evidenceAvailable: boolean;
  orderCount: number | null;
  soldUnits: number | null;
  refundedUnits: number | null;
  netUnits: number | null;
  productRevenue: number | null;
  refunds: number | null;
  netProductRevenue: number | null;
  cogs: number | null;
  costCoverage: number | null;
  contributionBeforeAds: number | null;
};

type ProductAdvertising = {
  evidenceAvailable: boolean;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  providerConversions: number | null;
  providerConversionValue: number | null;
  byProvider: Array<{
    provider: UnifiedAdvertisingProvider;
    spend: number;
    impressions: number;
    clicks: number;
    providerConversions: number | null;
    providerConversionValue: number | null;
  }>;
};

function emptyCommerce(available: boolean): ProductCommerce {
  return available
    ? {
        evidenceAvailable: true,
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
      }
    : {
        evidenceAvailable: false,
        orderCount: null,
        soldUnits: null,
        refundedUnits: null,
        netUnits: null,
        productRevenue: null,
        refunds: null,
        netProductRevenue: null,
        cogs: null,
        costCoverage: null,
        contributionBeforeAds: null,
      };
}

function commerceFromAggregate(
  row:
    | Awaited<
        ReturnType<CommerceAnalyticsReadRepository['getProductEconomicsAggregates']>
      >[number]
    | undefined,
  historyComplete: boolean,
): ProductCommerce {
  if (!row) return emptyCommerce(historyComplete);
  const netProductRevenue = Math.max(0, row.productRevenue - row.refunds);
  const costCoverage =
    row.costRelevantUnits > 0 ? row.costCoveredUnits / row.costRelevantUnits : 0;
  const cogs = costCoverage >= MIN_COST_COVERAGE ? row.rawCogs : null;
  return {
    evidenceAvailable: true,
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

function aggregateAdRows(
  rows: UnifiedProductAdMetricRow[],
  accountsById: Map<string, UnifiedAdvertisingAccountRow>,
): ProductAdvertising {
  if (rows.length === 0) {
    return {
      evidenceAvailable: false,
      spend: null,
      impressions: null,
      clicks: null,
      providerConversions: null,
      providerConversionValue: null,
      byProvider: [],
    };
  }
  const providers = new Map<UnifiedAdvertisingProvider, UnifiedProductAdMetricRow[]>();
  for (const row of rows) {
    const provider = accountsById.get(row.accountId)?.provider;
    if (!provider) continue;
    const values = providers.get(provider) ?? [];
    values.push(row);
    providers.set(provider, values);
  }
  const sum = (
    values: UnifiedProductAdMetricRow[],
    field: 'spend' | 'impressions' | 'clicks',
  ) => values.reduce((total, row) => total + row[field], 0);
  const nullableSum = (
    values: UnifiedProductAdMetricRow[],
    field: 'conversions' | 'conversionValue',
  ) => {
    const available = values.filter((row) => row[field] !== null);
    return available.length > 0
      ? available.reduce((total, row) => total + (row[field] ?? 0), 0)
      : null;
  };
  const byProvider = [...providers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, values]) => ({
      provider,
      spend: sum(values, 'spend'),
      impressions: sum(values, 'impressions'),
      clicks: sum(values, 'clicks'),
      providerConversions: nullableSum(values, 'conversions'),
      providerConversionValue: nullableSum(values, 'conversionValue'),
    }));
  return {
    evidenceAvailable: true,
    spend: sum(rows, 'spend'),
    impressions: sum(rows, 'impressions'),
    clicks: sum(rows, 'clicks'),
    providerConversions: nullableSum(rows, 'conversions'),
    providerConversionValue: nullableSum(rows, 'conversionValue'),
    byProvider,
  };
}

function pixelMetrics(
  row:
    | Awaited<ReturnType<IntelligenceStorefrontReadRepository['getEvidence']>>[number]
    | undefined,
) {
  if (!row) return { available: false as const, metrics: null };
  const divide = (num: number, den: number) => (den > 0 ? num / den : null);
  return {
    available: true as const,
    metrics: {
      sessions: row.sessionCount,
      productViewSessions: row.productViewSessionCount,
      addToCartSessions: row.addToCartSessionCount,
      checkoutStartSessions: row.checkoutStartSessionCount,
      linkedPurchaseSessions: row.linkedPurchaseSessionCount,
      productViewRate: divide(row.productViewSessionCount, row.sessionCount),
      viewToCartRate: divide(row.addToCartSessionCount, row.productViewSessionCount),
      checkoutStartRate: divide(row.checkoutStartSessionCount, row.addToCartSessionCount),
      linkedPurchaseRate: divide(row.linkedPurchaseSessionCount, row.sessionCount),
      cartAbandonmentRate:
        row.cartViewSessionCount > 0
          ? 1 - row.cartViewPurchaseSessionCount / row.cartViewSessionCount
          : null,
      checkoutAbandonmentRate:
        row.checkoutStartSessionCount > 0
          ? 1 - row.checkoutStartPurchaseSessionCount / row.checkoutStartSessionCount
          : null,
    },
  };
}

function inventoryStatus(input: {
  trusted: boolean;
  available: number | null;
  unitsPerDay: number | null;
  restockLeadTimeDays: number;
  lowStockThreshold: number;
}) {
  if (!input.trusted || input.available === null) {
    return { state: 'UNAVAILABLE' as const, daysCover: null };
  }
  const daysCover =
    input.unitsPerDay && input.unitsPerDay > 0
      ? Math.max(0, input.available) / input.unitsPerDay
      : null;
  if (input.available <= 0) return { state: 'SOLD_OUT' as const, daysCover };
  if (daysCover !== null && daysCover <= input.restockLeadTimeDays) {
    return { state: 'STOCKOUT_RISK' as const, daysCover };
  }
  if (input.available <= input.lowStockThreshold) {
    return { state: 'LOW_STOCK' as const, daysCover };
  }
  if ((input.unitsPerDay ?? 0) === 0 && input.available > input.lowStockThreshold * 3) {
    return { state: 'OVERSTOCK_WEAK_DEMAND' as const, daysCover };
  }
  return { state: 'HEALTHY' as const, daysCover };
}

function rankCompare(
  left: {
    current: { advertising: ProductAdvertising; commerce: ProductCommerce };
    product: { title: string };
  },
  right: {
    current: { advertising: ProductAdvertising; commerce: ProductCommerce };
    product: { title: string };
  },
) {
  const spend =
    (right.current.advertising.spend ?? -1) - (left.current.advertising.spend ?? -1);
  if (spend !== 0) return spend;
  const revenue =
    (right.current.commerce.netProductRevenue ?? -1) -
    (left.current.commerce.netProductRevenue ?? -1);
  if (revenue !== 0) return revenue;
  return left.product.title.localeCompare(right.product.title);
}

function insertRanked<T>(
  items: T[],
  item: T,
  maxItems: number,
  compare: (a: T, b: T) => number,
) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compare(item, items[middle]!) < 0) high = middle;
    else low = middle + 1;
  }
  items.splice(low, 0, item);
  if (items.length > maxItems) items.pop();
}

export class UnifiedProductAdsService {
  constructor(
    private readonly scope: UnifiedAdvertisingScopeService = unifiedAdvertisingScopeService,
    private readonly advertising: UnifiedAdvertisingRepository = new UnifiedAdvertisingRepository(),
    private readonly repository: UnifiedProductAdsRepository = new UnifiedProductAdsRepository(),
    private readonly commerce: CommerceAnalyticsReadRepository = new CommerceAnalyticsReadRepository(),
    private readonly intelligenceCommerce: IntelligenceCommerceReadRepository =
      new IntelligenceCommerceReadRepository(),
    private readonly storefront: IntelligenceStorefrontReadRepository =
      new IntelligenceStorefrontReadRepository(),
    private readonly context: IntelligenceContextReadRepository =
      new IntelligenceContextReadRepository(),
  ) {}

  async list(storeId: string, query: UnifiedAdvertisingListQuery, now = new Date()) {
    const dataset = await this.load(storeId, query, now, {
      page: query.page,
      limit: query.limit,
    });
    const ranked: Array<
      NonNullable<ReturnType<UnifiedProductAdsService['productItem']>>
    > = [];
    for (const productId of dataset.productIds) {
      const item = this.productItem(productId, dataset);
      if (item) insertRanked(ranked, item, query.limit, rankCompare);
    }
    return {
      ...this.header(dataset, query),
      summary: dataset.summary,
      items: ranked,
      pagination: pagination(query.page, query.limit, dataset.total),
    };
  }

  async detail(
    storeId: string,
    productId: string,
    query: UnifiedAdvertisingRangeQuery,
    now = new Date(),
  ) {
    const dataset = await this.load(storeId, query, now, {
      page: 1,
      limit: 1,
      productId,
    });
    const item = this.productItem(productId, dataset);
    if (!item) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
    return { ...this.header(dataset, query), summary: dataset.summary, ...item };
  }

  private async load(
    storeId: string,
    query: UnifiedAdvertisingRangeQuery,
    now: Date,
    page: { page: number; limit: number; productId?: string },
  ) {
    const context = await this.context.getContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(
      { from: query.from, to: query.to, days: query.days },
      context.ianaTimezone,
      now,
    );
    const scope = await this.scope.resolve({
      storeId,
      provider: query.provider,
      accountId: query.accountId,
      currency: query.currency,
    });
    const accountIds = scope.accounts.map((account) => account.id);
    const historyComplete =
      context.shopifyConnection?.status === 'ACTIVE' &&
      context.successfulOrderHistorySync?.status === 'SUCCEEDED';

    const [totalRows, accountingRows, candidates] = await Promise.all([
      this.advertising.metricRows({
        accounts: scope.accounts,
        currentFrom: windows.current.metaFrom,
        currentTo: windows.current.metaTo,
        comparisonFrom: windows.comparison.metaFrom,
        comparisonTo: windows.comparison.metaTo,
      }),
      this.repository.mappingAccountingRows({
        storeId,
        accounts: scope.accounts,
        currency: context.currencyCode,
        currentFrom: windows.current.metaFrom,
        currentTo: windows.current.metaTo,
        comparisonFrom: windows.comparison.metaFrom,
        comparisonTo: windows.comparison.metaTo,
      }),
      this.repository.rankedProductCandidates({
        storeId,
        accountIds,
        currency: context.currencyCode,
        currentFrom: windows.current.instantFrom,
        currentTo: windows.current.instantTo,
        comparisonFrom: windows.comparison.instantFrom,
        comparisonTo: windows.comparison.instantTo,
        metricCurrentFrom: windows.current.metaFrom,
        metricCurrentTo: windows.current.metaTo,
        metricComparisonFrom: windows.comparison.metaFrom,
        metricComparisonTo: windows.comparison.metaTo,
        historyComplete,
        page: page.page,
        limit: page.limit,
        productId: page.productId,
      }),
    ]);

    const productIds = candidates.productIds;
    const [mappings, resolutionRows, commerceRows, inventoryRows, storefrontRows, identities] =
      await Promise.all([
        this.repository.activeMappings(storeId, accountIds, productIds),
        this.repository.mappingResolutionsForProducts(storeId, accountIds, productIds),
        this.commerce.getProductEconomicsAggregates({
          storeId,
          currency: context.currencyCode,
          currentFrom: windows.current.instantFrom,
          currentTo: windows.current.instantTo,
          comparisonFrom: windows.comparison.instantFrom,
          comparisonTo: windows.comparison.instantTo,
          productIds,
        }),
        this.intelligenceCommerce.getInventoryEvidenceAggregates(storeId, productIds),
        this.storefront.getEvidence({
          storeId,
          currentFrom: new Date(`${windows.current.fromDate}T00:00:00.000Z`),
          currentTo: new Date(`${windows.current.toDate}T00:00:00.000Z`),
          comparisonFrom: new Date(`${windows.comparison.fromDate}T00:00:00.000Z`),
          comparisonTo: new Date(`${windows.comparison.toDate}T00:00:00.000Z`),
          productIds,
        }),
        this.repository.productIdentities(storeId, productIds),
      ]);

    const resolutions = new Map<string, MappingResolution>(
      resolutionRows.map((row) => [row.adId, row]),
    );
    const adIds = resolutionRows.map((row) => row.adId);
    const adRows = await this.repository.adMetricRows({
      accounts: scope.accounts,
      adIds,
      currentFrom: windows.current.metaFrom,
      currentTo: windows.current.metaTo,
      comparisonFrom: windows.comparison.metaFrom,
      comparisonTo: windows.comparison.metaTo,
    });
    const identitiesById = new Map(identities.map((product) => [product.id, product]));
    const commerceCurrent = new Map(
      commerceRows
        .filter((row) => row.period === 'CURRENT')
        .map((row) => [row.productId, row]),
    );
    const commerceComparison = new Map(
      commerceRows
        .filter((row) => row.period === 'COMPARISON')
        .map((row) => [row.productId, row]),
    );
    const inventoryByProduct = new Map(inventoryRows.map((row) => [row.productId, row]));
    const storefrontByProduct = new Map(
      storefrontRows
        .filter((row) => row.dimension === 'PRODUCT' && row.productId !== null)
        .map((row) => [`${row.productId}:${row.period}`, row]),
    );
    const accountsById = new Map(scope.accounts.map((account) => [account.id, account]));
    const exactAdsByProduct = new Map<string, MappingResolution[]>();
    for (const resolution of resolutions.values()) {
      if (resolution.classification !== 'EXACT' || !resolution.productId) continue;
      const values = exactAdsByProduct.get(resolution.productId) ?? [];
      values.push(resolution);
      exactAdsByProduct.set(resolution.productId, values);
    }
    const summary = this.totalAccounting({
      accounts: scope.accounts,
      totalRows,
      accountingRows,
      storeCurrency: context.currencyCode,
    });
    return {
      storeId,
      context,
      windows,
      accounts: scope.accounts,
      accountsById,
      mappings,
      resolutions,
      adRows,
      totalRows,
      productIds,
      total: candidates.total,
      identitiesById,
      commerceCurrent,
      commerceComparison,
      inventoryByProduct,
      storefrontByProduct,
      exactAdsByProduct,
      historyComplete,
      summary,
    };
  }

  private totalAccounting(input: {
    accounts: UnifiedAdvertisingAccountRow[];
    totalRows: UnifiedAdvertisingMetricRow[];
    accountingRows: UnifiedMappingAccountingRow[];
    storeCurrency: string;
  }) {
    const compatibleAccounts = input.accounts.filter(
      (account) => account.currency === input.storeCurrency,
    );
    const forPeriod = (period: UnifiedAdvertisingPeriod) => {
      const totalPeriod = input.totalRows.filter(
        (row) => row.period === period && row.currency === input.storeCurrency,
      );
      const observedAccounts = new Set(totalPeriod.map((row) => row.accountId));
      const missingAccountIds = compatibleAccounts
        .filter((account) => !observedAccounts.has(account.id))
        .map((account) => account.id);
      const totalEvidenceAvailable =
        compatibleAccounts.length > 0 && missingAccountIds.length === 0;
      const compatibleSpend = totalEvidenceAvailable
        ? totalPeriod.reduce((sum, row) => sum + row.spend, 0)
        : null;
      const periodRows = input.accountingRows.filter((row) => row.period === period);
      const exactRows = periodRows.filter((row) => row.classification === 'EXACT');
      const exactMappedSpend = exactRows.reduce((sum, row) => sum + row.spend, 0);
      const sharedSpend = periodRows
        .filter((row) => row.classification === 'SHARED')
        .reduce((sum, row) => sum + row.spend, 0);
      const ambiguousObservedSpend = periodRows
        .filter((row) => row.classification === 'AMBIGUOUS')
        .reduce((sum, row) => sum + row.spend, 0);
      const knownAllocated = exactMappedSpend + sharedSpend;
      const unmappedSpend =
        compatibleSpend === null ? null : Math.max(0, compatibleSpend - knownAllocated);
      const mappedByProvider = new Map<UnifiedAdvertisingProvider, number>();
      for (const row of exactRows) {
        mappedByProvider.set(row.provider, (mappedByProvider.get(row.provider) ?? 0) + row.spend);
      }
      return {
        evidenceAvailable: totalEvidenceAvailable,
        compatiblePaidSpend: compatibleSpend,
        exactMappedSpend,
        sharedSpend,
        unmappedSpend,
        ambiguousObservedSpend,
        mappingCoverage:
          compatibleSpend !== null && compatibleSpend > 0
            ? exactMappedSpend / compatibleSpend
            : null,
        missingAccountIds,
        exactMappedSpendByProvider: [...mappedByProvider.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([provider, spend]) => ({ provider, spend })),
      };
    };
    const current = forPeriod('CURRENT');
    const comparison = forPeriod('COMPARISON');
    return {
      currency: input.storeCurrency,
      current,
      comparison,
      change: {
        compatiblePaidSpend: percentChange(
          current.compatiblePaidSpend,
          comparison.compatiblePaidSpend,
        ),
        exactMappedSpend: percentChange(current.exactMappedSpend, comparison.exactMappedSpend),
        sharedSpend: percentChange(current.sharedSpend, comparison.sharedSpend),
        unmappedSpend: percentChange(current.unmappedSpend, comparison.unmappedSpend),
        mappingCoverage: percentChange(current.mappingCoverage, comparison.mappingCoverage),
      },
      limitations: [
        'Shared and ambiguous spend is never allocated to Shopify products.',
        'Performance Max or Shopping spend without defensible product-level canonical mappings remains unmapped.',
        'Provider-attributed conversions/value remain provider evidence and are not Shopify revenue.',
      ],
    };
  }

  private productItem(
    productId: string,
    dataset: Awaited<ReturnType<UnifiedProductAdsService['load']>>,
  ) {
    const product = dataset.identitiesById.get(productId);
    if (!product || product.deletedAt !== null) return null;
    const currentCommerce = commerceFromAggregate(
      dataset.commerceCurrent.get(productId),
      dataset.historyComplete,
    );
    const comparisonCommerce = commerceFromAggregate(
      dataset.commerceComparison.get(productId),
      dataset.historyComplete,
    );
    const exactAds = dataset.exactAdsByProduct.get(productId) ?? [];
    const exactAdIds = new Set(exactAds.map((resolution) => resolution.adId));
    const currentAdRows = dataset.adRows.filter(
      (row) =>
        row.period === 'CURRENT' &&
        exactAdIds.has(row.adId) &&
        row.currency === dataset.context.currencyCode,
    );
    const comparisonAdRows = dataset.adRows.filter(
      (row) =>
        row.period === 'COMPARISON' &&
        exactAdIds.has(row.adId) &&
        row.currency === dataset.context.currencyCode,
    );
    const currentAdvertising = aggregateAdRows(currentAdRows, dataset.accountsById);
    const comparisonAdvertising = aggregateAdRows(comparisonAdRows, dataset.accountsById);
    const currentObservedAds = new Set(currentAdRows.map((row) => row.adId));
    const comparisonObservedAds = new Set(comparisonAdRows.map((row) => row.adId));
    const currentMappingEvidenceComplete =
      exactAds.length > 0 && exactAds.every((mapping) => currentObservedAds.has(mapping.adId));
    const comparisonMappingEvidenceComplete =
      exactAds.length > 0 &&
      exactAds.every((mapping) => comparisonObservedAds.has(mapping.adId));
    const currentContributionAfterAds =
      currentCommerce.contributionBeforeAds !== null &&
      currentMappingEvidenceComplete &&
      currentAdvertising.spend !== null
        ? currentCommerce.contributionBeforeAds - currentAdvertising.spend
        : null;
    const comparisonContributionAfterAds =
      comparisonCommerce.contributionBeforeAds !== null &&
      comparisonMappingEvidenceComplete &&
      comparisonAdvertising.spend !== null
        ? comparisonCommerce.contributionBeforeAds - comparisonAdvertising.spend
        : null;
    const inventory = dataset.inventoryByProduct.get(productId);
    const currentNetUnits = currentCommerce.netUnits;
    const unitsPerDay =
      currentNetUnits === null ? null : currentNetUnits / dataset.windows.days;
    const inventoryView = inventoryStatus({
      trusted: dataset.context.inventoryIntelligenceMode === 'TRUSTED',
      available: inventory?.available ?? null,
      unitsPerDay,
      restockLeadTimeDays: dataset.context.inventoryRestockLeadTimeDays,
      lowStockThreshold: dataset.context.inventoryLowStockThreshold,
    });
    const currentPixel = pixelMetrics(
      dataset.storefrontByProduct.get(`${productId}:CURRENT`),
    );
    const comparisonPixel = pixelMetrics(
      dataset.storefrontByProduct.get(`${productId}:COMPARISON`),
    );
    const mappingRows = dataset.mappings.filter((row) => row.productId === productId);
    const exactConfidence =
      exactAds.length > 0 ? Math.min(...exactAds.map((mapping) => mapping.confidence)) : 0;
    const merchantConfirmed = exactAds.some((mapping) => mapping.merchantConfirmed);
    const mappingLimitations = [
      ...(mappingRows.length === 0 ? ['NO_ACTIVE_PRODUCT_MAPPING'] : []),
      ...(mappingRows.some(
        (row) => dataset.resolutions.get(row.adId)?.classification === 'AMBIGUOUS',
      )
        ? ['AMBIGUOUS_MAPPING_EXCLUDED']
        : []),
      ...(mappingRows.some(
        (row) => dataset.resolutions.get(row.adId)?.classification === 'SHARED',
      )
        ? ['SHARED_MAPPING_SPEND_UNALLOCATED']
        : []),
      ...(!currentMappingEvidenceComplete && exactAds.length > 0
        ? ['CURRENT_MAPPED_AD_EVIDENCE_INCOMPLETE']
        : []),
      ...(!comparisonMappingEvidenceComplete && exactAds.length > 0
        ? ['COMPARISON_MAPPED_AD_EVIDENCE_INCOMPLETE']
        : []),
    ];
    const confidence: Confidence =
      exactAds.length === 0 ||
      !currentMappingEvidenceComplete ||
      !currentCommerce.evidenceAvailable
        ? 'LOW'
        : merchantConfirmed &&
            currentCommerce.costCoverage !== null &&
            currentCommerce.costCoverage >= MIN_COST_COVERAGE
          ? 'HIGH'
          : exactConfidence >= MIN_AUTOMATIC_MAPPING_CONFIDENCE
            ? 'MEDIUM'
            : 'LOW';

    const current = {
      commerce: currentCommerce,
      advertising: currentAdvertising,
      storefront: currentPixel,
      inventory: {
        evidenceAvailable:
          dataset.context.inventoryIntelligenceMode === 'TRUSTED' && Boolean(inventory),
        available: inventory?.available ?? null,
        unitsPerDay,
        daysCover: inventoryView.daysCover,
        state: inventoryView.state,
      },
      intelligence: {
        contributionAfterAds: currentContributionAfterAds,
        inventoryPressure:
          currentAdvertising.spend !== null && currentAdvertising.spend > 0
            ? inventoryView.state
            : 'NO_MAPPED_PAID_DEMAND',
        inefficientPaidDemand:
          currentContributionAfterAds !== null &&
          currentAdvertising.spend !== null &&
          currentAdvertising.spend > 0
            ? currentContributionAfterAds < 0
            : null,
        profitableDemand:
          currentContributionAfterAds !== null &&
          currentAdvertising.spend !== null &&
          currentAdvertising.spend > 0
            ? currentContributionAfterAds > 0
            : null,
        confidence,
        limitations: mappingLimitations,
      },
    };
    const comparison = {
      commerce: comparisonCommerce,
      advertising: comparisonAdvertising,
      storefront: comparisonPixel,
      intelligence: { contributionAfterAds: comparisonContributionAfterAds },
    };

    return {
      product: {
        id: product.id,
        shopifyProductId: product.shopifyProductId,
        title: product.title,
        status: product.status,
      },
      mapping: {
        confidence: exactConfidence,
        merchantConfirmed,
        exactMappedAdCount: exactAds.length,
        limitations: mappingLimitations,
        evidence: mappingRows.map((row: UnifiedProductMappingRow) => ({
          provider: row.ad.account.provider,
          account: row.ad.account,
          mappingType: dataset.resolutions.get(row.adId)?.classification ?? 'AMBIGUOUS',
          granularity: row.granularity,
          source: row.source,
          confidence: row.confidence,
          evidence: row.evidence,
          validity: { from: row.validFrom, until: row.validUntil },
          merchantConfirmed: row.merchantConfirmed,
          ad: {
            id: row.ad.id,
            providerEntityId: row.ad.providerEntityId,
            name: row.ad.name,
            targetScope: row.ad.targetScope,
          },
          campaign: row.ad.campaign,
          group: row.ad.group,
        })),
      },
      current,
      comparison,
      change: {
        commerce: {
          netProductRevenue: percentChange(
            currentCommerce.netProductRevenue,
            comparisonCommerce.netProductRevenue,
          ),
          netUnits: percentChange(currentCommerce.netUnits, comparisonCommerce.netUnits),
          contributionBeforeAds: percentChange(
            currentCommerce.contributionBeforeAds,
            comparisonCommerce.contributionBeforeAds,
          ),
        },
        advertising: {
          spend: percentChange(currentAdvertising.spend, comparisonAdvertising.spend),
          impressions: percentChange(
            currentAdvertising.impressions,
            comparisonAdvertising.impressions,
          ),
          clicks: percentChange(currentAdvertising.clicks, comparisonAdvertising.clicks),
        },
        contributionAfterAds: percentChange(
          currentContributionAfterAds,
          comparisonContributionAfterAds,
        ),
      },
    };
  }

  private header(
    dataset: Awaited<ReturnType<UnifiedProductAdsService['load']>>,
    query: UnifiedAdvertisingRangeQuery,
  ) {
    return {
      schemaVersion: '2.0',
      filters: {
        provider: query.provider,
        accountId: query.accountId ?? null,
        currency: query.currency ?? null,
      },
      window: {
        current: {
          from: dataset.windows.current.fromDate,
          to: dataset.windows.current.toDate,
        },
        comparison: {
          from: dataset.windows.comparison.fromDate,
          to: dataset.windows.comparison.toDate,
        },
        days: dataset.windows.days,
      },
      currency: dataset.context.currencyCode,
      truthModel: {
        commerce: 'SHOPIFY',
        paidMedia: 'PROVIDER_REPORTED_ATTRIBUTION',
        storefront: 'STRIDE_PIXEL_FIRST_PARTY_OBSERVED',
      },
      mappingPolicy: {
        minimumAutomaticConfidence: MIN_AUTOMATIC_MAPPING_CONFIDENCE,
        merchantConfirmedOverridesAutomatic: true,
        exactSingleProductOnlyAffectsDirectEconomics: true,
        sharedAndAmbiguousSpendAllocated: false,
        pmaxSpendGuessedAcrossProducts: false,
      },
      methodology: {
        commerce: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
        directAdvertising: 'EXACT_CANONICAL_PRODUCT_MAPPING_SAME_STORE_CURRENCY_ONLY',
        totalAdvertising:
          'COMPLETE_SELECTED_ACCOUNT_CANONICAL_EVIDENCE_SAME_STORE_CURRENCY_ONLY',
        contributionAfterAds:
          'SHOPIFY_CONTRIBUTION_BEFORE_ADS_MINUS_EXACT_MAPPED_PAID_SPEND',
        profitLabel: 'CONTRIBUTION_AFTER_ADS_NOT_NET_PROFIT',
        pixel: 'FIRST_PARTY_OBSERVED_BEHAVIOR_NOT_CAUSAL_PROOF',
      },
    };
  }
}

export const unifiedProductAdsService = new UnifiedProductAdsService();
