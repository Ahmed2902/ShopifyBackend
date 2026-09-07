import type { IntelligenceCommerceEvidenceRow } from './intelligence-commerce.read.repository.js';
import type { IntelligenceRepository } from './intelligence.repository.js';
import type { SharedExposureEvidence, SharedExposureProductEvidence } from './intelligence.types.js';

type MetaRow = Awaited<ReturnType<IntelligenceRepository['getMetaEvidenceRows']>>[number];
type CommerceRow = Awaited<ReturnType<IntelligenceRepository['getCommerceRows']>>[number];
type InventoryRow = Awaited<ReturnType<IntelligenceRepository['getInventoryLevels']>>[number];
type TargetRow = Awaited<ReturnType<IntelligenceRepository['getSharedExposureTargets']>>[number];

const MIN_AUTOMATIC_CONFIDENCE = 0.7;

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function acceptedProductMappings(ad: TargetRow) {
  const confirmed = ad.productMappings.filter((mapping) => mapping.isMerchantConfirmed);
  return confirmed.length > 0
    ? confirmed
    : ad.productMappings.filter(
        (mapping) => numeric(mapping.confidence) >= MIN_AUTOMATIC_CONFIDENCE,
      );
}

function acceptedCollectionMappings(ad: TargetRow) {
  const confirmed = ad.collectionMappings.filter((mapping) => mapping.isMerchantConfirmed);
  return confirmed.length > 0
    ? confirmed
    : ad.collectionMappings.filter(
        (mapping) => numeric(mapping.confidence) >= MIN_AUTOMATIC_CONFIDENCE,
      );
}

function inventoryByProduct(rows: InventoryRow[]) {
  const stock = new Map<string, number>();
  for (const row of rows) {
    const productId = row.inventoryItem.variant.productId;
    stock.set(productId, (stock.get(productId) ?? 0) + row.available);
  }
  return stock;
}

function depletionByProduct(rows: CommerceRow[]) {
  const depletion = new Map<string, number>();
  for (const row of rows) {
    if (!row.productId) continue;
    const restockedUnits = row.refundLines.reduce(
      (sum, refund) => sum + (refund.restocked ? refund.quantity : 0),
      0,
    );
    const depletedUnits = Math.max(0, row.quantity - restockedUnits);
    depletion.set(row.productId, (depletion.get(row.productId) ?? 0) + depletedUnits);
  }
  return depletion;
}

function depletionByProductFromAggregates(rows: IntelligenceCommerceEvidenceRow[]) {
  return new Map(rows.map((row) => [row.productId, row.cogsUnits]));
}

function metaByAd(rows: MetaRow[]) {
  const metrics = new Map<string, { spend: number; impressions: number }>();
  for (const row of rows) {
    if (!row.ad) continue;
    const value = metrics.get(row.ad.id) ?? { spend: 0, impressions: 0 };
    value.spend += numeric(row.spend);
    value.impressions += numeric(row.impressions);
    metrics.set(row.ad.id, value);
  }
  return metrics;
}

function finishSharedExposureEvidence(
  input: {
    targets: TargetRow[];
    metaRows: MetaRow[];
    inventoryRows: InventoryRow[];
    inventoryTrusted: boolean;
    windowDays: number;
  },
  depletion: Map<string, number>,
): SharedExposureEvidence[] {
  const meta = metaByAd(input.metaRows);
  const stock = inventoryByProduct(input.inventoryRows);

  return input.targets.flatMap((ad) => {
    if (ad.targetScope !== 'MULTI_PRODUCT' && ad.targetScope !== 'COLLECTION') return [];

    const directMappings = ad.targetScope === 'MULTI_PRODUCT' ? acceptedProductMappings(ad) : [];
    const collectionMappings =
      ad.targetScope === 'COLLECTION' ? acceptedCollectionMappings(ad) : [];
    const products = new Map<string, { id: string; shopifyProductId: string; title: string }>();

    for (const mapping of directMappings) {
      if (mapping.product.deletedAt !== null) continue;
      products.set(mapping.product.id, {
        id: mapping.product.id,
        shopifyProductId: mapping.product.shopifyProductId,
        title: mapping.product.title,
      });
    }

    for (const mapping of collectionMappings) {
      if (mapping.collection.deletedAt !== null) continue;
      for (const membership of mapping.collection.products) {
        const product = membership.product;
        if (product.deletedAt !== null) continue;
        products.set(product.id, {
          id: product.id,
          shopifyProductId: product.shopifyProductId,
          title: product.title,
        });
      }
    }

    if (products.size === 0) return [];

    const productEvidence: SharedExposureProductEvidence[] = [...products.values()].map((product) => {
      const stockAvailable = stock.get(product.id) ?? null;
      const depletedUnits = depletion.get(product.id) ?? 0;
      const recentUnitsPerDay =
        depletedUnits > 0 ? depletedUnits / Math.max(1, input.windowDays) : null;
      const daysCover =
        input.inventoryTrusted &&
        stockAvailable !== null &&
        recentUnitsPerDay !== null &&
        recentUnitsPerDay > 0
          ? Math.max(0, stockAvailable) / recentUnitsPerDay
          : null;
      return {
        entityId: product.id,
        externalEntityId: product.shopifyProductId,
        name: product.title,
        stockAvailable,
        recentUnitsPerDay,
        daysCover,
      };
    });

    const adMetrics = meta.get(ad.id) ?? { spend: 0, impressions: 0 };
    const merchantConfirmed =
      directMappings.some((mapping) => mapping.isMerchantConfirmed) ||
      collectionMappings.some((mapping) => mapping.isMerchantConfirmed);
    const collections = collectionMappings
      .filter((mapping) => mapping.collection.deletedAt === null)
      .map((mapping) => {
        const productCount = mapping.collection._count.products;
        const evaluatedProductCount = mapping.collection.products.length;
        return {
          id: mapping.collection.id,
          shopifyCollectionId: mapping.collection.shopifyCollectionId,
          title: mapping.collection.title,
          handle: mapping.collection.handle,
          productCount,
          evaluatedProductCount,
          membershipTruncated: productCount > evaluatedProductCount,
        };
      });

    return [
      {
        entityId: ad.id,
        externalEntityId: ad.metaAdId,
        name: ad.name,
        currency: ad.adAccount.currency,
        scope: ad.targetScope,
        scopeConfidence: numeric(ad.targetScopeConfidence),
        merchantConfirmed,
        sharedAdSpend: adMetrics.spend,
        impressions: adMetrics.impressions,
        inventoryTrusted: input.inventoryTrusted,
        products: productEvidence,
        collectionMembershipTruncated: collections.some(
          (collection) => collection.membershipTruncated,
        ),
        collections,
      } satisfies SharedExposureEvidence,
    ];
  });
}

/** Raw characterization path retained for unit tests and DB parity checks. */
export function buildSharedExposureEvidence(input: {
  targets: TargetRow[];
  metaRows: MetaRow[];
  commerceRows: CommerceRow[];
  inventoryRows: InventoryRow[];
  inventoryTrusted: boolean;
  windowDays: number;
}): SharedExposureEvidence[] {
  return finishSharedExposureEvidence(input, depletionByProduct(input.commerceRows));
}

export function buildSharedExposureEvidenceFromAggregates(input: {
  targets: TargetRow[];
  metaRows: MetaRow[];
  commerceRows: IntelligenceCommerceEvidenceRow[];
  inventoryRows: InventoryRow[];
  inventoryTrusted: boolean;
  windowDays: number;
}): SharedExposureEvidence[] {
  return finishSharedExposureEvidence(
    input,
    depletionByProductFromAggregates(input.commerceRows),
  );
}
