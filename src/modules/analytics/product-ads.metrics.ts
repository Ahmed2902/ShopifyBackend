import type { AnalyticsRepository } from './analytics.repository.js';
import {
  aggregateMeta,
  aggregateProducts,
  emptyMetaMetrics,
  emptyProductMetrics,
  metricChanges,
  numeric,
  percentChange,
  type MetaMetrics,
  type ProductMetrics,
} from './analytics.metrics.js';
import type { ProductAdsRepository } from './product-ads.repository.js';

type CommerceRow = Awaited<ReturnType<AnalyticsRepository['getCommerceRows']>>[number];
type CostRow = Awaited<ReturnType<AnalyticsRepository['getVariantCosts']>>[number];
type MetaRow = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>[number];
type MappingRow = Awaited<ReturnType<ProductAdsRepository['getActiveMappings']>>[number];

export const MIN_AUTOMATIC_MAPPING_CONFIDENCE = 0.7;

export interface ExactAdMapping {
  adId: string;
  productId: string;
  confidence: number;
  merchantConfirmed: boolean;
  sources: string[];
  variantIds: string[];
  product: MappingRow['product'];
  rows: MappingRow[];
}

export interface ProductAdsPeriodProduct {
  product: {
    id: string;
    shopifyProductId: string;
    title: string;
    status: string;
  };
  commerce: ProductMetrics;
  advertising: MetaMetrics;
  derived: {
    contributionAfterAds: number | null;
    revenueShare: number;
    mappedSpendShare: number;
  };
  mapping: {
    confidence: number;
    mappedAdCount: number;
    merchantConfirmed: boolean;
    sources: string[];
  };
}

export interface ProductAdsPeriodResult {
  products: Map<string, ProductAdsPeriodProduct>;
  totals: {
    netProductRevenue: number;
    metaSpend: number;
    exactMappedSpend: number;
    unmappedSpend: number;
    mappingCoverage: number;
    excludedMetaSpend: Array<{ currency: string; spend: number }>;
  };
}

export function resolveExactAdMappings(mappings: MappingRow[]) {
  const byAd = new Map<string, MappingRow[]>();

  for (const mapping of mappings) {
    const rows = byAd.get(mapping.metaAdId) ?? [];
    rows.push(mapping);
    byAd.set(mapping.metaAdId, rows);
  }

  const exact = new Map<string, ExactAdMapping>();
  const ambiguousAdIds = new Set<string>();

  for (const [adId, rows] of byAd) {
    const confirmed = rows.filter((row) => row.isMerchantConfirmed);
    const candidates =
      confirmed.length > 0
        ? confirmed
        : rows.filter((row) => numeric(row.confidence) >= MIN_AUTOMATIC_MAPPING_CONFIDENCE);
    if (candidates.length === 0) continue;

    const productIds = new Set(candidates.map((row) => row.productId));
    if (productIds.size !== 1) {
      ambiguousAdIds.add(adId);
      continue;
    }

    const merchantConfirmed = confirmed.length > 0;
    exact.set(adId, {
      adId,
      productId: candidates[0]!.productId,
      confidence: merchantConfirmed
        ? 1
        : Math.max(...candidates.map((row) => numeric(row.confidence))),
      merchantConfirmed,
      sources: [...new Set(candidates.map((row) => row.source))].sort(),
      variantIds: [
        ...new Set(
          candidates
            .map((row) => row.variantId)
            .filter((variantId): variantId is string => variantId !== null),
        ),
      ],
      product: candidates[0]!.product,
      rows: candidates,
    });
  }

  return { exact, ambiguousAdIds };
}

export function buildProductAdsPeriod(input: {
  commerceRows: CommerceRow[];
  costRows: CostRow[];
  mappings: MappingRow[];
  metaRows: MetaRow[];
  storeCurrency: string;
}): ProductAdsPeriodResult {
  const commerceByProduct = aggregateProducts(input.commerceRows, input.costRows, input.storeCurrency);
  const { exact } = resolveExactAdMappings(input.mappings);
  const metaRowsByProduct = new Map<string, MetaRow[]>();
  const identityByProduct = new Map<string, ProductAdsPeriodProduct['product']>();
  const mappedSpendByProduct = new Map<string, number>();
  const weightedConfidenceByProduct = new Map<string, number>();
  const excludedSpendByCurrency = new Map<string, number>();
  let totalMetaSpend = 0;
  let exactMappedSpend = 0;

  for (const row of input.commerceRows) {
    if (!row.product || !row.productId || row.order.currencyCode !== input.storeCurrency) continue;
    identityByProduct.set(row.productId, {
      id: row.product.id,
      shopifyProductId: row.product.shopifyProductId,
      title: row.product.title,
      status: row.product.status,
    });
  }

  for (const mapping of exact.values()) {
    identityByProduct.set(mapping.productId, {
      id: mapping.product.id,
      shopifyProductId: mapping.product.shopifyProductId,
      title: mapping.product.title,
      status: mapping.product.status,
    });
  }

  for (const row of input.metaRows) {
    const spend = numeric(row.spend);
    if (row.accountCurrency !== input.storeCurrency) {
      excludedSpendByCurrency.set(
        row.accountCurrency,
        (excludedSpendByCurrency.get(row.accountCurrency) ?? 0) + spend,
      );
      continue;
    }

    totalMetaSpend += spend;
    if (!row.ad) continue;
    const mapping = exact.get(row.ad.id);
    if (!mapping) continue;

    exactMappedSpend += spend;
    const rows = metaRowsByProduct.get(mapping.productId) ?? [];
    rows.push(row);
    metaRowsByProduct.set(mapping.productId, rows);
    mappedSpendByProduct.set(
      mapping.productId,
      (mappedSpendByProduct.get(mapping.productId) ?? 0) + spend,
    );
    weightedConfidenceByProduct.set(
      mapping.productId,
      (weightedConfidenceByProduct.get(mapping.productId) ?? 0) + spend * mapping.confidence,
    );
  }

  const totalNetProductRevenue = [...commerceByProduct.values()].reduce(
    (sum, product) => sum + product.netProductRevenue,
    0,
  );
  const mappingCoverage = totalMetaSpend > 0 ? exactMappedSpend / totalMetaSpend : 0;
  const mappingsByProduct = new Map<string, ExactAdMapping[]>();
  for (const mapping of exact.values()) {
    const values = mappingsByProduct.get(mapping.productId) ?? [];
    values.push(mapping);
    mappingsByProduct.set(mapping.productId, values);
  }
  const activeMappingOnlyProductIds = [...mappingsByProduct.entries()]
    .filter(([, mappings]) => mappings.some((mapping) => mapping.product.deletedAt === null))
    .map(([productId]) => productId);
  const productIds = new Set([
    ...commerceByProduct.keys(),
    ...metaRowsByProduct.keys(),
    ...activeMappingOnlyProductIds,
  ]);
  const products = new Map<string, ProductAdsPeriodProduct>();

  for (const productId of productIds) {
    const product = identityByProduct.get(productId);
    if (!product) continue;

    const commerce = commerceByProduct.get(productId) ?? emptyProductMetrics();
    const advertising = aggregateMeta(metaRowsByProduct.get(productId) ?? []);
    const mappedAds = mappingsByProduct.get(productId) ?? [];
    const spend = mappedSpendByProduct.get(productId) ?? 0;
    const confidence =
      spend > 0
        ? (weightedConfidenceByProduct.get(productId) ?? 0) / spend
        : mappedAds.length > 0
          ? Math.max(...mappedAds.map((mapping) => mapping.confidence))
          : 0;

    products.set(productId, {
      product,
      commerce,
      advertising,
      derived: {
        contributionAfterAds:
          commerce.contributionBeforeAds === null || advertising.sourceRows === 0
            ? null
            : commerce.contributionBeforeAds - advertising.spend,
        revenueShare:
          totalNetProductRevenue > 0 ? commerce.netProductRevenue / totalNetProductRevenue : 0,
        mappedSpendShare: totalMetaSpend > 0 ? advertising.spend / totalMetaSpend : 0,
      },
      mapping: {
        confidence,
        mappedAdCount: mappedAds.length,
        merchantConfirmed: mappedAds.some((mapping) => mapping.merchantConfirmed),
        sources: [...new Set(mappedAds.flatMap((mapping) => mapping.sources))].sort(),
      },
    });
  }

  return {
    products,
    totals: {
      netProductRevenue: totalNetProductRevenue,
      metaSpend: totalMetaSpend,
      exactMappedSpend,
      unmappedSpend: Math.max(0, totalMetaSpend - exactMappedSpend),
      mappingCoverage,
      excludedMetaSpend: [...excludedSpendByCurrency.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, spend]) => ({ currency, spend })),
    },
  };
}

export function emptyProductAdsPeriodProduct(
  product: ProductAdsPeriodProduct['product'],
): ProductAdsPeriodProduct {
  return {
    product,
    commerce: emptyProductMetrics(),
    advertising: emptyMetaMetrics(),
    derived: {
      contributionAfterAds: null,
      revenueShare: 0,
      mappedSpendShare: 0,
    },
    mapping: {
      confidence: 0,
      mappedAdCount: 0,
      merchantConfirmed: false,
      sources: [],
    },
  };
}

export function productAdsChanges(
  current: ProductAdsPeriodProduct,
  comparison: ProductAdsPeriodProduct,
) {
  return {
    commerce: metricChanges(current.commerce, comparison.commerce),
    advertising: metricChanges(current.advertising, comparison.advertising),
    derived: {
      contributionAfterAds: percentChange(
        current.derived.contributionAfterAds,
        comparison.derived.contributionAfterAds,
      ),
      revenueShare: percentChange(current.derived.revenueShare, comparison.derived.revenueShare),
      mappedSpendShare: percentChange(
        current.derived.mappedSpendShare,
        comparison.derived.mappedSpendShare,
      ),
    },
  };
}
