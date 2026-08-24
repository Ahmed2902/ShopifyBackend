export interface TikTokMappingVariant {
  id: string;
  productId: string;
  shopifyVariantId: string;
  shopifyProductId: string;
  sku: string | null;
  barcode: string | null;
  productHandle: string | null;
  productTitle: string;
  options: Array<{ name: string; value: string }>;
}

export interface TikTokMappingCatalogItem {
  id: string;
  tiktokProductId: string;
  retailerId: string | null;
  itemGroupId: string | null;
  title: string | null;
  size: string | null;
  color: string | null;
  pattern: string | null;
  url: string | null;
}

export interface TikTokMappingAd {
  id: string;
  tiktokAdId: string;
  landingPageUrl: string | null;
  catalogId: string | null;
  productSetId: string | null;
  creativeJson: unknown;
  rawJson: unknown;
}

export interface CatalogResolution {
  variantIds: string[];
  source: 'RETAILER_ID_SKU' | 'URL' | 'PRODUCT_GROUP' | null;
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface AdResolution {
  mappings: Array<{
    productId: string;
    variantId: string | null;
    catalogItemId: string | null;
    granularity: 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT';
    source: 'CATALOG_ITEM' | 'LANDING_PAGE' | 'CREATIVE_PRODUCT_DATA';
    confidence: number;
    evidence: Record<string, unknown>;
    providerProductId?: string | null;
    providerProductGroupId?: string | null;
  }>;
  targetScope: 'STORE' | 'COLLECTION' | 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT' | 'MULTI_PRODUCT' | 'UNKNOWN';
  confidence: number;
  evidence: Record<string, unknown>;
}
