import { AppError } from '../../../errors/app-error.js';
import { resolveTikTokAd, resolveTikTokCatalogItem } from './tiktok-mapping.resolver.js';
import { TikTokMappingRepository } from './tiktok-mapping.repository.js';
import type {
  CatalogResolution,
  TikTokMappingAd,
  TikTokMappingCatalogItem,
  TikTokMappingVariant,
} from './tiktok-mapping.types.js';

export class TikTokMappingService {
  constructor(private readonly repository: TikTokMappingRepository) {}

  async resolveMappings(storeId: string) {
    const dataset = await this.requireDataset(storeId);
    const hosts = new Set(
      [dataset.myshopifyDomain, dataset.primaryDomainHost]
        .filter((host): host is string => Boolean(host))
        .map((host) => host.toLowerCase().replace(/^www\./, '')),
    );
    const variants: TikTokMappingVariant[] = dataset.variants.map((variant) => ({
      id: variant.id,
      productId: variant.productId,
      shopifyVariantId: variant.shopifyVariantId,
      sku: variant.sku,
      barcode: variant.barcode,
      shopifyProductId: variant.product.shopifyProductId,
      productHandle: variant.product.handle,
      productTitle: variant.product.title,
      options: variant.options,
    }));
    const catalogItems: TikTokMappingCatalogItem[] = dataset.tiktokCatalogs.flatMap((catalog) => catalog.items);
    const catalogResolutions = new Map<string, CatalogResolution>();

    for (const item of catalogItems) {
      const resolution = resolveTikTokCatalogItem(item, variants, hosts);
      catalogResolutions.set(item.id, resolution);
      if (resolution.source) {
        await this.repository.replaceAutomaticCatalogMappings(
          item.id,
          resolution.variantIds.map((variantId) => ({
            variantId,
            source: resolution.source!,
            confidence: resolution.confidence,
          })),
        );
      }
    }

    const ads: TikTokMappingAd[] = dataset.tiktokAdvertisers.flatMap((advertiser) => advertiser.ads);
    for (const ad of ads) {
      const resolution = resolveTikTokAd(ad, variants, catalogItems, catalogResolutions, hosts);
      await this.repository.replaceAutomaticAdMappings(
        ad.id,
        resolution.mappings.map((mapping) => ({ ...mapping, evidenceJson: mapping.evidence })),
      );
      await this.repository.updateAdTargetScope(
        ad.id,
        resolution.targetScope,
        resolution.confidence,
        resolution.evidence,
      );
    }

    return { catalogs: catalogItems.length, ads: ads.length };
  }

  async setManualAdMapping(storeId: string, externalAdId: string, productId: string, variantId: string | null) {
    const dataset = await this.requireDataset(storeId);
    if (!dataset.tiktokAdvertisers.some((advertiser) => advertiser.ads.some((ad) => ad.tiktokAdId === externalAdId))) {
      throw new AppError('TikTok ad not found in selected advertisers', 404, 'TIKTOK_AD_NOT_FOUND');
    }
    const mapping = await this.repository.replaceManualAdMapping(storeId, externalAdId, productId, variantId);
    if (!mapping) throw new AppError('TikTok ad/product/variant mapping is invalid', 400, 'TIKTOK_MAPPING_INVALID');
    return mapping;
  }

  async setManualCatalogMapping(storeId: string, catalogItemId: string, variantId: string) {
    const dataset = await this.requireDataset(storeId);
    if (!dataset.tiktokCatalogs.some((catalog) => catalog.items.some((item) => item.id === catalogItemId))) {
      throw new AppError('TikTok catalog item not found in selected catalogs', 404, 'TIKTOK_CATALOG_ITEM_NOT_FOUND');
    }
    const mapping = await this.repository.replaceManualCatalogMapping(storeId, catalogItemId, variantId);
    if (!mapping) throw new AppError('TikTok catalog mapping is invalid', 400, 'TIKTOK_MAPPING_INVALID');
    return mapping;
  }

  private async requireDataset(storeId: string) {
    const dataset = await this.repository.loadDataset(storeId);
    if (!dataset) throw new AppError('TikTok is not connected for this store', 409, 'TIKTOK_NOT_CONNECTED');
    return dataset;
  }
}

export const tiktokMappingService = new TikTokMappingService(new TikTokMappingRepository());
