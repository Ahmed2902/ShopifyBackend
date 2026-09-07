import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const optionalJson = (value: unknown): Prisma.InputJsonValue | undefined => value == null ? undefined : json(value);

export class TikTokMappingRepository {
  async loadDataset(storeId: string) {
    const connection = await prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: { selectedCatalogIds: true, selectedAdvertiserIds: true },
    });
    if (!connection) return null;

    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        myshopifyDomain: true,
        primaryDomainHost: true,
        variants: {
          where: { deletedAt: null },
          select: {
            id: true, shopifyVariantId: true, sku: true, barcode: true, productId: true, options: true,
            product: { select: { shopifyProductId: true, title: true, handle: true } },
          },
        },
        tiktokCatalogs: {
          where: { tiktokCatalogId: { in: connection.selectedCatalogIds } },
          select: { items: { where: { deletedAt: null }, select: {
            id: true, tiktokProductId: true, retailerId: true, itemGroupId: true, title: true,
            size: true, color: true, pattern: true, url: true,
          } } },
        },
        tiktokAdvertisers: {
          where: { advertiserId: { in: connection.selectedAdvertiserIds } },
          select: { ads: { where: { deletedAt: null }, select: {
            id: true, tiktokAdId: true, landingPageUrl: true, catalogId: true,
            productSetId: true, creativeJson: true, rawJson: true,
          } } },
        },
      },
    });
  }

  updateAdTargetScope(id: string, targetScope: 'STORE' | 'COLLECTION' | 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT' | 'MULTI_PRODUCT' | 'UNKNOWN', confidence: number, evidence: unknown) {
    return prisma.tikTokAd.update({ where: { id }, data: { targetScope, targetScopeConfidence: confidence, targetScopeEvidence: json(evidence) } });
  }

  async replaceAutomaticCatalogMappings(catalogItemId: string, mappings: Array<{ variantId: string; source: 'RETAILER_ID_SKU' | 'URL' | 'PRODUCT_GROUP' | 'INFERRED'; confidence: number }>) {
    return prisma.$transaction(async (tx) => {
      const confirmed = await tx.tikTokCatalogItemVariantMapping.findMany({ where: { catalogItemId, validUntil: null, isMerchantConfirmed: true } });
      if (confirmed.length) return confirmed;
      await tx.tikTokCatalogItemVariantMapping.updateMany({ where: { catalogItemId, validUntil: null, isMerchantConfirmed: false }, data: { validUntil: new Date() } });
      const created = [];
      // Interactive Prisma transactions use one database connection. Promise.all() here does not
      // create real DB parallelism and pg warns when multiple queries are issued concurrently on
      // that connection, so keep transaction-client operations explicitly sequential.
      for (const mapping of mappings) {
        created.push(await tx.tikTokCatalogItemVariantMapping.create({ data: { catalogItemId, ...mapping, isMerchantConfirmed: false } }));
      }
      return created;
    });
  }

  async replaceAutomaticAdMappings(tiktokAdId: string, mappings: Array<{
    productId: string; variantId?: string | null; catalogItemId?: string | null;
    granularity: 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT';
    source: 'CATALOG_ITEM' | 'LANDING_PAGE' | 'CREATIVE_PRODUCT_DATA' | 'INFERRED';
    confidence: number; evidenceJson?: unknown; landingUrl?: string | null;
    providerProductId?: string | null; providerProductGroupId?: string | null;
  }>) {
    return prisma.$transaction(async (tx) => {
      const confirmed = await tx.tikTokAdProductMapping.findMany({ where: { tiktokAdId, validUntil: null, isMerchantConfirmed: true } });
      if (confirmed.length) return confirmed;
      await tx.tikTokAdProductMapping.updateMany({ where: { tiktokAdId, validUntil: null, isMerchantConfirmed: false }, data: { validUntil: new Date() } });
      const created = [];
      for (const mapping of mappings) {
        created.push(await tx.tikTokAdProductMapping.create({ data: {
          tiktokAdId,
          productId: mapping.productId,
          variantId: mapping.variantId ?? null,
          catalogItemId: mapping.catalogItemId ?? null,
          granularity: mapping.granularity,
          source: mapping.source,
          confidence: mapping.confidence,
          evidenceJson: optionalJson(mapping.evidenceJson),
          landingUrl: mapping.landingUrl ?? null,
          providerProductId: mapping.providerProductId ?? null,
          providerProductGroupId: mapping.providerProductGroupId ?? null,
          isMerchantConfirmed: false,
        } }));
      }
      return created;
    });
  }

  async replaceManualAdMapping(storeId: string, externalAdId: string, productId: string, variantId: string | null) {
    const ad = await prisma.tikTokAd.findFirst({ where: { tiktokAdId: externalAdId, advertiser: { storeId }, deletedAt: null }, select: { id: true } });
    const product = await prisma.product.findFirst({ where: { id: productId, storeId, deletedAt: null }, select: { id: true } });
    if (!ad || !product) return null;
    if (variantId) {
      const variant = await prisma.productVariant.findFirst({ where: { id: variantId, storeId, productId, deletedAt: null }, select: { id: true } });
      if (!variant) return null;
    }
    return prisma.$transaction(async (tx) => {
      await tx.tikTokAdProductMapping.updateMany({ where: { tiktokAdId: ad.id, validUntil: null }, data: { validUntil: new Date() } });
      return tx.tikTokAdProductMapping.create({ data: {
        tiktokAdId: ad.id, productId, variantId,
        granularity: variantId ? 'VARIANT' : 'PRODUCT', source: 'MANUAL', confidence: 1, isMerchantConfirmed: true,
      } });
    });
  }

  async replaceManualCatalogMapping(storeId: string, catalogItemId: string, variantId: string) {
    const [item, variant] = await Promise.all([
      prisma.tikTokCatalogItem.findFirst({ where: { id: catalogItemId, catalog: { storeId }, deletedAt: null }, select: { id: true } }),
      prisma.productVariant.findFirst({ where: { id: variantId, storeId, deletedAt: null }, select: { id: true } }),
    ]);
    if (!item || !variant) return null;
    return prisma.$transaction(async (tx) => {
      await tx.tikTokCatalogItemVariantMapping.updateMany({ where: { catalogItemId, validUntil: null }, data: { validUntil: new Date() } });
      return tx.tikTokCatalogItemVariantMapping.create({ data: { catalogItemId, variantId, source: 'MANUAL', confidence: 1, isMerchantConfirmed: true } });
    });
  }
}
