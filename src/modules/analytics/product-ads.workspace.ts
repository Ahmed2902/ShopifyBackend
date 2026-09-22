import { AppError } from '../../errors/app-error.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { commerceRowDate, percentChange } from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from './analytics.schema.js';
import { pagination, splitCommerce, splitMeta, windowResponse } from './analytics.shared.js';
import {
  buildProductAdsPeriod,
  emptyProductAdsPeriodProduct,
  productAdsChanges,
  resolveExactAdMappings,
  MIN_AUTOMATIC_MAPPING_CONFIDENCE,
} from './product-ads.metrics.js';
import { ProductAdsRepository } from './product-ads.repository.js';

type MappingRow = Awaited<ReturnType<ProductAdsRepository['getActiveMappings']>>[number];

export class ProductAdsWorkspace {
  constructor(
    private readonly analyticsRepository: AnalyticsRepository = new AnalyticsRepository(),
    private readonly productAdsRepository: ProductAdsRepository = new ProductAdsRepository(),
  ) {}

  async list(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const dataset = await this.loadDataset(storeId, query, now);
    const ids = new Set([
      ...dataset.current.products.keys(),
      ...dataset.comparison.products.keys(),
    ]);

    const items = [...ids]
      .map((productId) => this.periodPair(productId, dataset.current, dataset.comparison))
      .filter((item) => item !== null)
      .sort((left, right) => {
        const spend = right.current.advertising.spend - left.current.advertising.spend;
        if (spend !== 0) return spend;
        const revenue =
          right.current.commerce.netProductRevenue - left.current.commerce.netProductRevenue;
        if (revenue !== 0) return revenue;
        return left.product.title.localeCompare(right.product.title);
      });

    const start = (query.page - 1) * query.limit;
    const pageItems = items.slice(start, start + query.limit);

    return {
      window: windowResponse(dataset.windows),
      currency: dataset.store.currencyCode,
      methodology: this.methodology(),
      mappingPolicy: this.mappingPolicy(),
      summary: this.summary(dataset.current.totals, dataset.comparison.totals),
      items: pageItems,
      pagination: pagination(query.page, query.limit, items.length),
    };
  }

  async detail(storeId: string, productId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const [product, dataset] = await Promise.all([
      this.analyticsRepository.getProduct(storeId, productId),
      this.loadDataset(storeId, query, now),
    ]);

    const pair = this.periodPair(
      productId,
      dataset.current,
      dataset.comparison,
      product
        ? {
            id: product.id,
            shopifyProductId: product.shopifyProductId,
            title: product.title,
            status: product.status,
          }
        : undefined,
    );
    if (!pair) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

    return {
      window: windowResponse(dataset.windows),
      currency: dataset.store.currencyCode,
      methodology: this.methodology(),
      mappingPolicy: this.mappingPolicy(),
      summary: this.summary(dataset.current.totals, dataset.comparison.totals),
      ...pair,
      mappings: this.mappingEvidence(productId, dataset.mappings),
    };
  }

  private async loadDataset(storeId: string, query: AnalyticsRangeQuery, now: Date) {
    const store = await this.analyticsRepository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const configuredAccountIds = store.metaConnection?.selectedAdAccountIds ?? [];
    if (
      query.accountId &&
      (!store.metaConnection || !configuredAccountIds.includes(query.accountId))
    ) {
      throw new AppError(
        'Meta ad account is not selected for this store',
        400,
        'META_AD_ACCOUNT_NOT_SELECTED',
      );
    }
    const selectedAccountIds = query.accountId ? [query.accountId] : configuredAccountIds;
    const [commerceRows, metaRows, mappings] = await Promise.all([
      this.analyticsRepository.getCommerceRows(
        storeId,
        windows.comparison.instantFrom,
        windows.current.instantTo,
      ),
      this.analyticsRepository.getMetaRows(
        storeId,
        selectedAccountIds,
        windows.comparison.metaFrom,
        windows.current.metaTo,
      ),
      this.productAdsRepository.getActiveMappings(storeId, selectedAccountIds),
    ]);

    const variantIds = [
      ...new Set(
        commerceRows
          .map((row) => row.variantId)
          .filter((variantId): variantId is string => variantId !== null),
      ),
    ];
    const costs = await this.analyticsRepository.getVariantCosts(
      storeId,
      variantIds,
      windows.comparison.instantFrom,
      windows.current.instantTo,
    );
    const commerce = splitCommerce(commerceRows, windows, commerceRowDate);
    const meta = splitMeta(metaRows, windows);

    return {
      store,
      windows,
      mappings,
      current: buildProductAdsPeriod({
        commerceRows: commerce.current,
        costRows: costs,
        mappings,
        metaRows: meta.current,
        storeCurrency: store.currencyCode,
      }),
      comparison: buildProductAdsPeriod({
        commerceRows: commerce.comparison,
        costRows: costs,
        mappings,
        metaRows: meta.comparison,
        storeCurrency: store.currencyCode,
      }),
    };
  }

  private periodPair(
    productId: string,
    current: ReturnType<typeof buildProductAdsPeriod>,
    comparison: ReturnType<typeof buildProductAdsPeriod>,
    fallbackProduct?: { id: string; shopifyProductId: string; title: string; status: string },
  ) {
    const currentValue = current.products.get(productId);
    const comparisonValue = comparison.products.get(productId);
    const product = currentValue?.product ?? comparisonValue?.product ?? fallbackProduct;
    if (!product) return null;

    const currentPeriod = currentValue ?? emptyProductAdsPeriodProduct(product);
    const comparisonPeriod = comparisonValue ?? emptyProductAdsPeriodProduct(product);
    const mapping =
      currentPeriod.mapping.mappedAdCount > 0 ? currentPeriod.mapping : comparisonPeriod.mapping;

    return {
      product,
      mapping,
      current: {
        commerce: currentPeriod.commerce,
        advertising: currentPeriod.advertising,
        derived: currentPeriod.derived,
      },
      comparison: {
        commerce: comparisonPeriod.commerce,
        advertising: comparisonPeriod.advertising,
        derived: comparisonPeriod.derived,
      },
      change: productAdsChanges(currentPeriod, comparisonPeriod),
    };
  }

  private mappingEvidence(productId: string, mappings: MappingRow[]) {
    const { exact } = resolveExactAdMappings(mappings);
    return [...exact.values()]
      .filter((mapping) => mapping.productId === productId)
      .sort((left, right) => left.rows[0]!.ad.name.localeCompare(right.rows[0]!.ad.name))
      .map((mapping) => {
        const row = mapping.rows[0]!;
        const variants = new Map(
          mapping.rows
            .filter((item) => item.variant !== null)
            .map((item) => [item.variant!.id, item.variant!] as const),
        );
        return {
          confidence: mapping.confidence,
          merchantConfirmed: mapping.merchantConfirmed,
          sources: mapping.sources,
          ad: row.ad,
          variants: [...variants.values()],
        };
      });
  }

  private summary(
    current: ReturnType<typeof buildProductAdsPeriod>['totals'],
    comparison: ReturnType<typeof buildProductAdsPeriod>['totals'],
  ) {
    return {
      current,
      comparison,
      change: {
        netProductRevenue: percentChange(current.netProductRevenue, comparison.netProductRevenue),
        metaSpend: percentChange(current.metaSpend, comparison.metaSpend),
        exactMappedSpend: percentChange(current.exactMappedSpend, comparison.exactMappedSpend),
        unmappedSpend: percentChange(current.unmappedSpend, comparison.unmappedSpend),
        mappingCoverage: percentChange(current.mappingCoverage, comparison.mappingCoverage),
      },
    };
  }

  private methodology() {
    return {
      commerce: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
      advertising: 'META_PROVIDER_ATTRIBUTION_SAME_STORE_CURRENCY_ONLY',
      mapping: 'EXACT_SINGLE_PRODUCT_MAPPING_ONLY',
      mappingSnapshot: 'CURRENT_ACTIVE_MAPPING_APPLIED_TO_SELECTED_HISTORY',
      contribution: 'SHOPIFY_CONTRIBUTION_BEFORE_ADS_MINUS_MAPPED_META_SPEND',
      profitLabel: 'CONTRIBUTION_AFTER_ADS_NOT_NET_PROFIT',
    };
  }

  private mappingPolicy() {
    return {
      minimumAutomaticConfidence: MIN_AUTOMATIC_MAPPING_CONFIDENCE,
      merchantConfirmedOverridesAutomatic: true,
      selectedMetaAccountsOnly: true,
      multiProductAdsExcluded: true,
      sameProductMultiVariantAdsAccepted: true,
    };
  }
}

export const productAdsWorkspace = new ProductAdsWorkspace();
