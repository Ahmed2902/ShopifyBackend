import { asRecord, asString } from '../tiktok.utils.js';
import type {
  AdResolution,
  CatalogResolution,
  TikTokMappingAd,
  TikTokMappingCatalogItem,
  TikTokMappingVariant,
} from './tiktok-mapping.types.js';

const PRODUCT_PATH = /(?:^|\/)products\/([^/?#]+)/i;
const COLLECTION_PATH = /(?:^|\/)collections\/([^/?#]+)/i;
const SHOPIFY_COMPOSITE_ID = /^shopify_(?:[a-z]{2,3}_)?(\d+)_(\d+)$/i;
const PRODUCT_ID_KEYS = new Set(['product_id', 'product_ids', 'retailer_id', 'retailer_ids', 'content_id', 'content_ids']);

function numericTail(value: string): string | null {
  return value.match(/(\d+)$/)?.[1] ?? null;
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function matchingVariants(token: string, variants: TikTokMappingVariant[]): TikTokMappingVariant[] {
  const normalized = token.trim();
  if (!normalized) return [];
  const composite = normalized.match(SHOPIFY_COMPOSITE_ID);
  return variants.filter((variant) => {
    const variantIds = [variant.shopifyVariantId, numericTail(variant.shopifyVariantId), variant.sku, variant.barcode].filter(Boolean);
    if (variantIds.includes(normalized)) return true;
    if (!composite) return false;
    return numericTail(variant.shopifyProductId) === composite[1] && numericTail(variant.shopifyVariantId) === composite[2];
  });
}

function matchingProductVariants(token: string, variants: TikTokMappingVariant[]): TikTokMappingVariant[] {
  const tail = numericTail(token);
  return variants.filter((variant) => variant.shopifyProductId === token || (tail && numericTail(variant.shopifyProductId) === tail));
}

function parseShopifyUrl(rawUrl: string, hosts: Set<string>) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!hosts.has(host)) return { kind: 'EXTERNAL' as const };
    const product = url.pathname.match(PRODUCT_PATH)?.[1];
    if (product) return { kind: 'PRODUCT' as const, handle: decodeURIComponent(product).toLowerCase(), variant: url.searchParams.get('variant') };
    const collection = url.pathname.match(COLLECTION_PATH)?.[1];
    if (collection) return { kind: 'COLLECTION' as const, handle: decodeURIComponent(collection).toLowerCase() };
    return url.pathname.replace(/\/+$/, '') === '' ? { kind: 'STORE' as const } : { kind: 'OTHER' as const };
  } catch {
    return { kind: 'INVALID' as const };
  }
}

function filterOptions(variants: TikTokMappingVariant[], item: TikTokMappingCatalogItem) {
  const hints = [
    ['color', item.color], ['colour', item.color], ['size', item.size], ['pattern', item.pattern],
  ].filter((pair): pair is [string, string] => Boolean(pair[1]));
  if (hints.length === 0) return variants;
  const narrowed = variants.filter((variant) => hints.every(([name, value]) =>
    variant.options.some((option) => option.name.toLowerCase() === name && option.value.toLowerCase() === value.toLowerCase()),
  ));
  return narrowed.length > 0 ? narrowed : variants;
}

export function resolveTikTokCatalogItem(
  item: TikTokMappingCatalogItem,
  variants: TikTokMappingVariant[],
  hosts: Set<string>,
): CatalogResolution {
  if (item.retailerId) {
    const matches = matchingVariants(item.retailerId, variants);
    if (matches.length === 1) return { variantIds: [matches[0]!.id], source: 'RETAILER_ID_SKU', confidence: 1, evidence: { matchedBy: 'retailer_id', value: item.retailerId } };
  }

  if (item.url) {
    const parsed = parseShopifyUrl(item.url, hosts);
    if (parsed.kind === 'PRODUCT') {
      let matches = variants.filter((variant) => variant.productHandle?.toLowerCase() === parsed.handle);
      if (parsed.variant) {
        const ids = new Set(matchingVariants(parsed.variant, variants).map((variant) => variant.id));
        matches = matches.filter((variant) => ids.has(variant.id));
      }
      matches = filterOptions(matches, item);
      if (matches.length === 1) return { variantIds: [matches[0]!.id], source: 'URL', confidence: parsed.variant ? 1 : 0.97, evidence: { matchedBy: 'shopify_product_url', url: item.url } };
      if (matches.length > 1) return { variantIds: matches.map((variant) => variant.id), source: 'URL', confidence: 0.9, evidence: { matchedBy: 'shopify_product_url', url: item.url, multiVariantProduct: true } };
    }
  }

  if (item.itemGroupId) {
    const matches = filterOptions(matchingProductVariants(item.itemGroupId, variants), item);
    if (matches.length === 1) return { variantIds: [matches[0]!.id], source: 'PRODUCT_GROUP', confidence: 0.95, evidence: { matchedBy: 'item_group_id', value: item.itemGroupId } };
    if (matches.length > 1) return { variantIds: matches.map((variant) => variant.id), source: 'PRODUCT_GROUP', confidence: 0.88, evidence: { matchedBy: 'item_group_id', value: item.itemGroupId, multiVariantProduct: true } };
  }

  return { variantIds: [], source: null, confidence: 0, evidence: { reason: 'no_deterministic_match' } };
}

function collectProviderIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderIds(item, found);
    return found;
  }
  const record = asRecord(value);
  for (const [key, child] of Object.entries(record)) {
    if (PRODUCT_ID_KEYS.has(key.toLowerCase())) {
      const values = Array.isArray(child) ? child : [child];
      for (const candidate of values) {
        const token = asString(candidate);
        if (token) found.add(token);
      }
    }
    collectProviderIds(child, found);
  }
  return found;
}

export function resolveTikTokAd(
  ad: TikTokMappingAd,
  variants: TikTokMappingVariant[],
  catalogItems: TikTokMappingCatalogItem[],
  catalogResolutions: Map<string, CatalogResolution>,
  hosts: Set<string>,
): AdResolution {
  const mappings: AdResolution['mappings'] = [];
  const providerIds = collectProviderIds([ad.creativeJson, ad.rawJson]);

  for (const token of providerIds) {
    const itemMatches = catalogItems.filter((item) => item.tiktokProductId === token || item.retailerId === token || item.itemGroupId === token);
    for (const item of itemMatches) {
      const resolution = catalogResolutions.get(item.id);
      for (const variantId of resolution?.variantIds ?? []) {
        const variant = variants.find((entry) => entry.id === variantId);
        if (!variant) continue;
        mappings.push({ productId: variant.productId, variantId, catalogItemId: item.id, granularity: 'VARIANT', source: 'CATALOG_ITEM', confidence: Math.min(1, resolution!.confidence), evidence: { matchedBy: 'creative_catalog_product_id', token }, providerProductId: item.tiktokProductId, providerProductGroupId: item.itemGroupId });
      }
    }
  }

  if (mappings.length === 0 && ad.landingPageUrl) {
    const parsed = parseShopifyUrl(ad.landingPageUrl, hosts);
    if (parsed.kind === 'PRODUCT') {
      let matches = variants.filter((variant) => variant.productHandle?.toLowerCase() === parsed.handle);
      if (parsed.variant) {
        const ids = new Set(matchingVariants(parsed.variant, variants).map((variant) => variant.id));
        matches = matches.filter((variant) => ids.has(variant.id));
      }
      if (matches.length === 1) {
        mappings.push({ productId: matches[0]!.productId, variantId: matches[0]!.id, catalogItemId: null, granularity: 'VARIANT', source: 'LANDING_PAGE', confidence: 0.99, evidence: { matchedBy: 'landing_url', url: ad.landingPageUrl } });
      } else if (matches.length > 1) {
        mappings.push({ productId: matches[0]!.productId, variantId: null, catalogItemId: null, granularity: 'PRODUCT', source: 'LANDING_PAGE', confidence: 0.94, evidence: { matchedBy: 'landing_url', url: ad.landingPageUrl } });
      }
    }
  }

  const deduped = uniqueBy(mappings, (mapping) => `${mapping.productId}:${mapping.variantId ?? ''}:${mapping.catalogItemId ?? ''}`);
  if (deduped.length > 0) {
    const productIds = new Set(deduped.map((mapping) => mapping.productId));
    const allVariants = deduped.every((mapping) => Boolean(mapping.variantId));
    return {
      mappings: deduped,
      targetScope: productIds.size > 1 ? 'MULTI_PRODUCT' : allVariants && deduped.length === 1 ? 'VARIANT' : 'PRODUCT',
      confidence: Math.min(...deduped.map((mapping) => mapping.confidence)),
      evidence: { mappingCount: deduped.length, providerIds: [...providerIds] },
    };
  }

  if (ad.catalogId || ad.productSetId) {
    return { mappings: [], targetScope: 'MULTI_PRODUCT', confidence: 0.6, evidence: { reason: 'catalog_or_product_set_without_item_level_evidence', catalogId: ad.catalogId, productSetId: ad.productSetId } };
  }
  if (ad.landingPageUrl) {
    const parsed = parseShopifyUrl(ad.landingPageUrl, hosts);
    if (parsed.kind === 'COLLECTION') return { mappings: [], targetScope: 'COLLECTION', confidence: 0.95, evidence: { landingPageUrl: ad.landingPageUrl } };
    if (parsed.kind === 'STORE') return { mappings: [], targetScope: 'STORE', confidence: 0.95, evidence: { landingPageUrl: ad.landingPageUrl } };
  }
  return { mappings: [], targetScope: 'UNKNOWN', confidence: 0, evidence: { reason: 'no_deterministic_ad_match' } };
}
