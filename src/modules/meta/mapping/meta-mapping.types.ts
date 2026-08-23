export type MappingGranularity = 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT';
export type AdTargetScope =
  | 'STORE'
  | 'COLLECTION'
  | 'PRODUCT'
  | 'PRODUCT_OPTION'
  | 'VARIANT'
  | 'MULTI_PRODUCT'
  | 'UNKNOWN';

export type CatalogMappingSource =
  | 'RETAILER_ID_SKU'
  | 'PRODUCT_GROUP'
  | 'URL'
  | 'MANUAL'
  | 'INFERRED';

export type AdMappingSource =
  | 'CATALOG_ITEM'
  | 'PRODUCT_SET'
  | 'CREATIVE_PRODUCT_DATA'
  | 'CREATIVE_TEXT'
  | 'URL'
  | 'UTM'
  | 'LANDING_PAGE'
  | 'MANUAL'
  | 'INFERRED';

export interface ShopifyVariantIdentity {
  id: string;
  shopifyVariantId: string;
  sku: string | null;
  productId: string;
  shopifyProductId: string;
  productHandle: string | null;
  productTitle: string;
  options: Array<{ name: string; value: string }>;
}

export interface CatalogItemIdentity {
  id: string;
  metaProductItemId: string;
  retailerId: string | null;
  retailerProductGroupId: string | null;
  parentProductId: string | null;
  url: string | null;
  color: string | null;
  size: string | null;
  pattern: string | null;
  name: string | null;
  activeMappings: Array<{
    id: string;
    variantId: string;
    source: CatalogMappingSource;
    confidence: number;
    isMerchantConfirmed: boolean;
  }>;
}

export interface MetaAdIdentity {
  id: string;
  metaAdId: string;
  name: string;
  creative: {
    id: string;
    productSetId: string | null;
    productData: unknown;
    assetFeedSpec: unknown;
    resolvedDestinationUrls: unknown;
    linkUrl: string | null;
    linkDeepLinkUrl: string | null;
    objectUrl: string | null;
    templateUrl: string | null;
    urlTags: string | null;
    title: string | null;
    body: string | null;
  } | null;
  adSetPromotedObject: unknown;
  campaignPromotedObject: unknown;
  activeMappings: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    catalogItemId: string | null;
    granularity: MappingGranularity;
    optionSelector: unknown;
    source: AdMappingSource;
    confidence: number;
    isMerchantConfirmed: boolean;
  }>;
}

export interface MappingDataset {
  store: {
    myshopifyDomain: string;
    primaryDomainHost: string | null;
  };
  variants: ShopifyVariantIdentity[];
  catalogItems: CatalogItemIdentity[];
  ads: MetaAdIdentity[];
}

export interface CatalogResolution {
  state: 'MAPPED' | 'AMBIGUOUS' | 'UNMAPPED';
  variantIds: string[];
  source: CatalogMappingSource | null;
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface DesiredAdMapping {
  productId: string;
  variantId: string | null;
  catalogItemId: string | null;
  granularity: MappingGranularity;
  optionSelector: Record<string, string[]> | null;
  source: AdMappingSource;
  confidence: number;
  landingUrl: string | null;
  providerProductId: string | null;
  providerProductGroupId: string | null;
  evidence: Record<string, unknown>;
}

export interface AdSuggestion {
  productId: string;
  productTitle: string;
  confidence: number;
  source: 'CREATIVE_TEXT';
  evidence: Record<string, unknown>;
}

export interface AdResolution {
  scope: AdTargetScope;
  confidence: number;
  mappings: DesiredAdMapping[];
  evidence: Record<string, unknown>;
  suggestions: AdSuggestion[];
}
