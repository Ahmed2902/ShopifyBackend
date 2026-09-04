import { AppError } from '../../errors/app-error.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import {
  aggregateMeta,
  commerceRowDate,
  emptyMetaMetrics,
  metricChanges,
} from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from './analytics.schema.js';
import { pagination, splitCommerce, splitMeta, windowResponse } from './analytics.shared.js';
import {
  AD_EXPOSURE_DETAIL_MEMBER_LIMIT,
  AD_EXPOSURE_LIST_MEMBER_LIMIT,
  AdExposureRepository,
} from './ad-exposure.repository.js';

type AdRow = NonNullable<Awaited<ReturnType<AdExposureRepository['getAd']>>>;
type CommerceRow = Awaited<ReturnType<AnalyticsRepository['getCommerceRows']>>[number];
type InventoryRow = Awaited<ReturnType<AdExposureRepository['getInventoryForProducts']>>[number];
type MetaRow = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>[number];

type Limitation = { code: string; message: string };

const MIN_AUTOMATIC_CONFIDENCE = 0.7;
const PRODUCT_SCOPES: AdRow['targetScope'][] = [
  'PRODUCT',
  'PRODUCT_OPTION',
  'VARIANT',
  'MULTI_PRODUCT',
];

function precision(scope: AdRow['targetScope']) {
  switch (scope) {
    case 'PRODUCT':
    case 'PRODUCT_OPTION':
    case 'VARIANT':
      return 'EXACT_PRODUCT' as const;
    case 'MULTI_PRODUCT':
      return 'SHARED_MULTI_PRODUCT' as const;
    case 'COLLECTION':
      return 'COLLECTION' as const;
    case 'STORE':
      return 'STORE' as const;
    default:
      return 'UNKNOWN' as const;
  }
}

function evidenceQuality(confidence: number, limitations: Limitation[]) {
  const serious = limitations.some((item) =>
    ['TARGET_UNRESOLVED', 'TARGET_UNKNOWN'].includes(item.code),
  );
  if (!serious && confidence >= 0.9) return 'HIGH' as const;
  if (confidence >= MIN_AUTOMATIC_CONFIDENCE) return 'MEDIUM' as const;
  return 'LOW' as const;
}

function acceptedProductMappings(ad: AdRow) {
  if (!PRODUCT_SCOPES.includes(ad.targetScope)) return [];
  const confirmed = ad.productMappings.filter((mapping) => mapping.isMerchantConfirmed);
  return confirmed.length > 0
    ? confirmed
    : ad.productMappings.filter(
        (mapping) => Number(mapping.confidence) >= MIN_AUTOMATIC_CONFIDENCE,
      );
}

function acceptedCollectionMappings(ad: AdRow) {
  if (ad.targetScope !== 'COLLECTION') return [];
  const confirmed = ad.collectionMappings.filter((mapping) => mapping.isMerchantConfirmed);
  return confirmed.length > 0
    ? confirmed
    : ad.collectionMappings.filter(
        (mapping) => Number(mapping.confidence) >= MIN_AUTOMATIC_CONFIDENCE,
      );
}

function targetProductIds(ad: AdRow): string[] {
  const ids = new Set<string>();
  if (ad.targetScope === 'COLLECTION') {
    for (const mapping of acceptedCollectionMappings(ad)) {
      if (mapping.collection.deletedAt !== null) continue;
      for (const membership of mapping.collection.products) {
        if (membership.product.deletedAt === null) ids.add(membership.product.id);
      }
    }
    return [...ids];
  }

  if (PRODUCT_SCOPES.includes(ad.targetScope)) {
    for (const mapping of acceptedProductMappings(ad)) {
      if (mapping.product.deletedAt === null) ids.add(mapping.productId);
    }
  }
  return [...ids];
}

function groupMetaRows(rows: MetaRow[]): Map<string, MetaRow[]> {
  const grouped = new Map<string, MetaRow[]>();
  for (const row of rows) {
    if (!row.ad) continue;
    const values = grouped.get(row.ad.id) ?? [];
    values.push(row);
    grouped.set(row.ad.id, values);
  }
  return grouped;
}

function inventoryByProduct(rows: InventoryRow[]) {
  const grouped = new Map<
    string,
    { available: number; incoming: number; committed: number; onHand: number }
  >();
  for (const row of rows) {
    const productId = row.inventoryItem.variant.productId;
    const value = grouped.get(productId) ?? {
      available: 0,
      incoming: 0,
      committed: 0,
      onHand: 0,
    };
    value.available += row.available;
    value.incoming += row.incoming;
    value.committed += row.committed;
    value.onHand += row.onHand;
    grouped.set(productId, value);
  }
  return grouped;
}

function depletionByProduct(rows: CommerceRow[]) {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    if (!row.productId) continue;
    const restocked = row.refundLines.reduce(
      (sum, refund) => sum + (refund.restocked ? refund.quantity : 0),
      0,
    );
    const depletion = Math.max(0, row.quantity - restocked);
    grouped.set(row.productId, (grouped.get(row.productId) ?? 0) + depletion);
  }
  return grouped;
}

export class AdExposureWorkspace {
  constructor(
    private readonly analyticsRepository: AnalyticsRepository = new AnalyticsRepository(),
    private readonly repository: AdExposureRepository = new AdExposureRepository(),
  ) {}

  async list(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const context = await this.context(storeId, query, now);
    const page = await this.repository.getAdsPage(
      storeId,
      context.selectedAccountIds,
      query.page,
      query.limit,
    );
    const items = await this.enrichAds(
      storeId,
      page.items,
      context,
      AD_EXPOSURE_LIST_MEMBER_LIMIT,
    );
    return {
      window: windowResponse(context.windows),
      methodology: this.methodology(),
      items,
      pagination: pagination(query.page, query.limit, page.total),
    };
  }

  async detail(storeId: string, adId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const context = await this.context(storeId, query, now);
    const ad = await this.repository.getAd(storeId, context.selectedAccountIds, adId);
    if (!ad) throw new AppError('Ad not found', 404, 'META_AD_NOT_FOUND');
    const [item] = await this.enrichAds(
      storeId,
      [ad],
      context,
      AD_EXPOSURE_DETAIL_MEMBER_LIMIT,
    );
    if (!item) throw new AppError('Ad not found', 404, 'META_AD_NOT_FOUND');
    return {
      window: windowResponse(context.windows),
      methodology: this.methodology(),
      ...item,
    };
  }

  private async context(storeId: string, query: AnalyticsRangeQuery, now: Date) {
    const store = await this.analyticsRepository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return {
      store,
      selectedAccountIds: store.metaConnection?.selectedAdAccountIds ?? [],
      windows: resolveAnalyticsWindows(query, store.ianaTimezone, now),
    };
  }

  private async enrichAds(
    storeId: string,
    ads: AdRow[],
    context: Awaited<ReturnType<AdExposureWorkspace['context']>>,
    collectionMemberLimit: number,
  ) {
    if (ads.length === 0) return [];
    const adIds = ads.map((ad) => ad.id);
    const productIds = [...new Set(ads.flatMap(targetProductIds))];
    const [metaRows, commerceRows, inventoryRows] = await Promise.all([
      this.analyticsRepository.getMetaRows(
        storeId,
        context.selectedAccountIds,
        context.windows.comparison.metaFrom,
        context.windows.current.metaTo,
        { adIds },
      ),
      this.analyticsRepository.getCommerceRows(
        storeId,
        context.windows.current.instantFrom,
        context.windows.current.instantTo,
        productIds,
      ),
      this.repository.getInventoryForProducts(storeId, productIds),
    ]);
    const meta = splitMeta(metaRows, context.windows);
    const currentMeta = groupMetaRows(meta.current);
    const comparisonMeta = groupMetaRows(meta.comparison);
    const currentCommerce = splitCommerce(
      commerceRows,
      context.windows,
      commerceRowDate,
    ).current;
    const depletion = depletionByProduct(currentCommerce);
    const inventory = inventoryByProduct(inventoryRows);

    return ads.map((ad) =>
      this.enrichAd(
        ad,
        currentMeta.get(ad.id) ?? [],
        comparisonMeta.get(ad.id) ?? [],
        depletion,
        inventory,
        context.windows.days,
        context.store.inventoryIntelligenceMode === 'TRUSTED',
        collectionMemberLimit,
      ),
    );
  }

  private enrichAd(
    ad: AdRow,
    currentRows: MetaRow[],
    comparisonRows: MetaRow[],
    depletion: Map<string, number>,
    inventory: Map<string, { available: number; incoming: number; committed: number; onHand: number }>,
    days: number,
    inventoryTrusted: boolean,
    collectionMemberLimit: number,
  ) {
    const current = currentRows.length > 0 ? aggregateMeta(currentRows) : emptyMetaMetrics();
    const comparison =
      comparisonRows.length > 0 ? aggregateMeta(comparisonRows) : emptyMetaMetrics();
    const productMappings = acceptedProductMappings(ad);
    const collectionMappings = acceptedCollectionMappings(ad);
    const limitations: Limitation[] = [];
    const scopeConfidence = Number(ad.targetScopeConfidence ?? 0);

    if (PRODUCT_SCOPES.includes(ad.targetScope) && productMappings.length === 0) {
      limitations.push({
        code: 'TARGET_UNRESOLVED',
        message:
          'The ad has product-level target scope, but no current non-deleted Shopify product target is linked.',
      });
    }
    if (ad.targetScope === 'MULTI_PRODUCT') {
      limitations.push({
        code: 'SHARED_SPEND_NOT_ALLOCATED',
        message:
          'Ad spend is known for the shared creative, but Stride does not divide it between promoted products without provider evidence.',
      });
    }
    if (ad.targetScope === 'COLLECTION') {
      if (collectionMappings.length === 0) {
        limitations.push({
          code: 'TARGET_UNRESOLVED',
          message:
            'The ad is recognized as collection-level, but the Shopify collection entity is not linked.',
        });
      } else {
        limitations.push({
          code: 'CURRENT_COLLECTION_MEMBERSHIP',
          message:
            'Collection exposure uses current Shopify collection membership rather than reconstructed historical membership.',
        });
        limitations.push({
          code: 'SHARED_SPEND_NOT_ALLOCATED',
          message:
            'Collection ad spend is retained at ad level and is not divided between collection products.',
        });
        if (
          collectionMappings.some(
            (mapping) => mapping.collection._count.products > mapping.collection.products.length,
          )
        ) {
          limitations.push({
            code: 'COLLECTION_MEMBERS_TRUNCATED',
            message: `Collection member expansion is bounded to ${collectionMemberLimit} products per linked collection in this response; collection-level spend remains unallocated.`,
          });
        }
      }
    }
    if (ad.targetScope === 'STORE') {
      limitations.push({
        code: 'STORE_LEVEL_EXPOSURE',
        message: 'This ad is linked only to the storefront, not to specific Shopify products.',
      });
    }
    if (ad.targetScope === 'UNKNOWN') {
      limitations.push({
        code: 'TARGET_UNKNOWN',
        message: 'Stride does not have deterministic Shopify target evidence for this ad.',
      });
    }
    if (!inventoryTrusted && ['MULTI_PRODUCT', 'COLLECTION'].includes(ad.targetScope)) {
      limitations.push({
        code: 'INVENTORY_NOT_TRUSTED',
        message: 'Inventory context is diagnostic only until the merchant marks Shopify inventory as trusted.',
      });
    }

    const directProducts = new Map<
      string,
      {
        product: AdRow['productMappings'][number]['product'];
        variants: Map<string, NonNullable<AdRow['productMappings'][number]['variant']>>;
      }
    >();
    for (const mapping of productMappings) {
      if (mapping.product.deletedAt !== null) continue;
      const direct = directProducts.get(mapping.product.id) ?? {
        product: mapping.product,
        variants: new Map(),
      };
      if (mapping.variant && mapping.variant.deletedAt === null) {
        direct.variants.set(mapping.variant.id, mapping.variant);
      }
      directProducts.set(mapping.product.id, direct);
    }

    const collectionProducts = new Map<
      string,
      {
        product: AdRow['collectionMappings'][number]['collection']['products'][number]['product'];
        position: number | null;
      }
    >();
    for (const mapping of collectionMappings) {
      if (mapping.collection.deletedAt !== null) continue;
      for (const membership of mapping.collection.products) {
        if (membership.product.deletedAt !== null) continue;
        if (!collectionProducts.has(membership.product.id)) {
          collectionProducts.set(membership.product.id, {
            product: membership.product,
            position: membership.position,
          });
        }
      }
    }

    const targetIds = new Set([...directProducts.keys(), ...collectionProducts.keys()]);
    const exactProductScope = ['PRODUCT', 'PRODUCT_OPTION', 'VARIANT'].includes(ad.targetScope);
    const products = [...targetIds].map((productId) => {
      const direct = directProducts.get(productId);
      const collection = collectionProducts.get(productId);
      const product = direct?.product ?? collection?.product;
      const stock = inventory.get(productId) ?? null;
      const units = depletion.get(productId) ?? 0;
      const recentUnitsPerDay = units > 0 ? units / Math.max(1, days) : null;
      const daysCover =
        inventoryTrusted && stock && recentUnitsPerDay && recentUnitsPerDay > 0
          ? Math.max(0, stock.available) / recentUnitsPerDay
          : null;
      return {
        product,
        variants: direct ? [...direct.variants.values()] : [],
        optionSelectors: productMappings
          .filter(
            (mapping) =>
              mapping.productId === productId &&
              mapping.granularity === 'PRODUCT_OPTION' &&
              mapping.optionSelector !== null,
          )
          .map((mapping) => mapping.optionSelector),
        relationship: direct ? 'DIRECT' : 'COLLECTION_MEMBER',
        collectionPosition: collection?.position ?? null,
        allocatedAdSpend: exactProductScope && targetIds.size === 1 ? current.spend : null,
        inventory: stock,
        recentObservedUnitsPerDay: recentUnitsPerDay,
        daysCover,
      };
    });

    return {
      ad: {
        id: ad.id,
        metaAdId: ad.metaAdId,
        name: ad.name,
        configuredStatus: ad.configuredStatus,
        effectiveStatus: ad.effectiveStatus,
        campaign: ad.campaign,
        adSet: ad.adSet,
        creative: ad.creative,
      },
      currency: ad.adAccount.currency,
      scope: {
        type: ad.targetScope,
        confidence: scopeConfidence,
        evidence: ad.targetScopeEvidence,
        merchantConfirmed:
          productMappings.some((mapping) => mapping.isMerchantConfirmed) ||
          collectionMappings.some((mapping) => mapping.isMerchantConfirmed),
        evidenceQuality: evidenceQuality(scopeConfidence, limitations),
        attributionPrecision: precision(ad.targetScope),
      },
      current,
      comparison,
      change: metricChanges(current, comparison),
      targets: {
        products,
        collections: collectionMappings.map((mapping) => ({
          id: mapping.collection.id,
          shopifyCollectionId: mapping.collection.shopifyCollectionId,
          title: mapping.collection.title,
          handle: mapping.collection.handle,
          confidence: Number(mapping.confidence),
          merchantConfirmed: mapping.isMerchantConfirmed,
          source: mapping.source,
          landingUrl: mapping.landingUrl,
          productCount: mapping.collection._count.products,
          membersReturned: mapping.collection.products.length,
          membersTruncated:
            mapping.collection._count.products > mapping.collection.products.length,
        })),
      },
      limitations,
    };
  }

  private methodology() {
    return {
      advertising: 'META_PROVIDER_ATTRIBUTION_AT_AD_LEVEL',
      mapping: 'CURRENT_ACTIVE_DETERMINISTIC_OR_MERCHANT_CONFIRMED_TARGETS',
      sharedExposure: 'AD_LEVEL_SPEND_NOT_ALLOCATED_ACROSS_MULTI_PRODUCT_OR_COLLECTION_TARGETS',
      collectionMembership: 'CURRENT_SHOPIFY_COLLECTION_MEMBERSHIP_BOUNDED_EXPANSION',
      inventory: 'CURRENT_AVAILABLE_DIVIDED_BY_OBSERVED_STOCK_DEPLETION_RATE',
      prediction: 'NONE',
    };
  }
}

export const adExposureWorkspace = new AdExposureWorkspace();
