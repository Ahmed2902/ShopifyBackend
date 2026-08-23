import type {
  AdResolution,
  AdSuggestion,
  CatalogItemIdentity,
  CatalogResolution,
  DesiredAdMapping,
  MappingDataset,
  MappingGranularity,
  MetaAdIdentity,
  ShopifyVariantIdentity,
} from './meta-mapping.types.js';

const RESOLVER_VERSION = 1;
const PRODUCT_PATH = /(?:^|\/)products\/([^/?#]+)/i;
const COLLECTION_PATH = /(?:^|\/)collections\/([^/?#]+)/i;
const SHOPIFY_COMPOSITE_ID = /^shopify_(?:[a-z]{2,3}_)?(\d+)_(\d+)$/i;
const PROVIDER_ID_KEYS = new Set([
  'product_id',
  'product_ids',
  'retailer_id',
  'retailer_ids',
  'product_retailer_id',
  'product_retailer_ids',
  'content_id',
  'content_ids',
]);

interface ResolverIndex {
  hosts: Set<string>;
  variantsById: Map<string, ShopifyVariantIdentity>;
  variantsByExternalId: Map<string, ShopifyVariantIdentity[]>;
  variantsByProduct: Map<string, ShopifyVariantIdentity[]>;
  variantsByHandle: Map<string, ShopifyVariantIdentity[]>;
  variantsByProductExternalId: Map<string, ShopifyVariantIdentity[]>;
  catalogItemsByProviderId: Map<string, CatalogItemIdentity[]>;
  productTitles: Array<{ productId: string; title: string; normalized: string }>;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function numericTail(value: string): string | null {
  const match = value.match(/(\d+)$/);
  return match?.[1] ?? null;
}

function addMulti<T>(map: Map<string, T[]>, key: string | null | undefined, value: T): void {
  const normalized = key?.trim();
  if (!normalized) return;
  const values = map.get(normalized) ?? [];
  values.push(value);
  map.set(normalized, values);
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function buildIndex(dataset: MappingDataset): ResolverIndex {
  const hosts = new Set<string>([normalizeHost(dataset.store.myshopifyDomain)]);
  if (dataset.store.primaryDomainHost) hosts.add(normalizeHost(dataset.store.primaryDomainHost));

  const variantsById = new Map<string, ShopifyVariantIdentity>();
  const variantsByExternalId = new Map<string, ShopifyVariantIdentity[]>();
  const variantsByProduct = new Map<string, ShopifyVariantIdentity[]>();
  const variantsByHandle = new Map<string, ShopifyVariantIdentity[]>();
  const variantsByProductExternalId = new Map<string, ShopifyVariantIdentity[]>();
  const productTitles = new Map<string, { productId: string; title: string; normalized: string }>();

  for (const variant of dataset.variants) {
    variantsById.set(variant.id, variant);
    addMulti(variantsByExternalId, variant.shopifyVariantId, variant);
    addMulti(variantsByExternalId, numericTail(variant.shopifyVariantId), variant);
    addMulti(variantsByExternalId, variant.sku, variant);

    addMulti(variantsByProduct, variant.productId, variant);
    if (variant.productHandle) addMulti(variantsByHandle, variant.productHandle.toLowerCase(), variant);

    addMulti(variantsByProductExternalId, variant.shopifyProductId, variant);
    addMulti(variantsByProductExternalId, numericTail(variant.shopifyProductId), variant);

    productTitles.set(variant.productId, {
      productId: variant.productId,
      title: variant.productTitle,
      normalized: normalizeText(variant.productTitle),
    });
  }

  const catalogItemsByProviderId = new Map<string, CatalogItemIdentity[]>();
  for (const item of dataset.catalogItems) {
    addMulti(catalogItemsByProviderId, item.metaProductItemId, item);
    addMulti(catalogItemsByProviderId, item.retailerId, item);
    addMulti(catalogItemsByProviderId, item.retailerProductGroupId, item);
  }

  return {
    hosts,
    variantsById,
    variantsByExternalId,
    variantsByProduct,
    variantsByHandle,
    variantsByProductExternalId,
    catalogItemsByProviderId,
    productTitles: [...productTitles.values()],
  };
}

function resolveCompositeVariant(
  token: string,
  index: ResolverIndex,
): ShopifyVariantIdentity[] {
  const match = token.match(SHOPIFY_COMPOSITE_ID);
  if (!match) return [];
  const [, productNumericId, variantNumericId] = match;
  const candidates = index.variantsByExternalId.get(variantNumericId!) ?? [];
  return candidates.filter(
    (variant) => numericTail(variant.shopifyProductId) === productNumericId,
  );
}

function resolveVariantToken(token: string, index: ResolverIndex): ShopifyVariantIdentity[] {
  const normalized = token.trim();
  if (!normalized) return [];
  const direct = index.variantsByExternalId.get(normalized) ?? [];
  const composite = resolveCompositeVariant(normalized, index);
  return uniqueById([...direct, ...composite]);
}

function resolveProductToken(token: string, index: ResolverIndex): ShopifyVariantIdentity[] {
  const normalized = token.trim();
  if (!normalized) return [];
  const direct = index.variantsByProductExternalId.get(normalized) ?? [];
  const composite = normalized.match(SHOPIFY_COMPOSITE_ID);
  if (composite) {
    return uniqueById([
      ...direct,
      ...(index.variantsByProductExternalId.get(composite[1]!) ?? []),
    ]);
  }
  return uniqueById(direct);
}

function parseStoreUrl(rawUrl: string, index: ResolverIndex) {
  try {
    const url = new URL(rawUrl);
    if (!index.hosts.has(normalizeHost(url.hostname))) return { kind: 'EXTERNAL' as const, url };

    const productMatch = url.pathname.match(PRODUCT_PATH);
    if (productMatch?.[1]) {
      return {
        kind: 'PRODUCT' as const,
        url,
        handle: decodeURIComponent(productMatch[1]).toLowerCase(),
        variantToken: url.searchParams.get('variant'),
      };
    }

    const collectionMatch = url.pathname.match(COLLECTION_PATH);
    if (collectionMatch?.[1]) {
      return {
        kind: 'COLLECTION' as const,
        url,
        handle: decodeURIComponent(collectionMatch[1]).toLowerCase(),
      };
    }

    const path = url.pathname.replace(/\/+$/, '');
    return path === '' ? { kind: 'STORE' as const, url } : { kind: 'OTHER' as const, url };
  } catch {
    return { kind: 'INVALID' as const, url: null };
  }
}

function optionAliases(item: CatalogItemIdentity): Array<{ aliases: string[]; value: string }> {
  const hints: Array<{ aliases: string[]; value: string }> = [];
  if (item.color) hints.push({ aliases: ['color', 'colour'], value: item.color });
  if (item.size) hints.push({ aliases: ['size'], value: item.size });
  if (item.pattern) hints.push({ aliases: ['pattern'], value: item.pattern });
  return hints;
}

function filterVariantsByCatalogHints(
  variants: ShopifyVariantIdentity[],
  item: CatalogItemIdentity,
): { variants: ShopifyVariantIdentity[]; selector: Record<string, string[]> } {
  const selector: Record<string, string[]> = {};
  const hints = optionAliases(item);
  if (hints.length === 0) return { variants, selector };

  for (const hint of hints) {
    const matchingNames = new Set<string>();
    for (const variant of variants) {
      for (const option of variant.options) {
        if (
          hint.aliases.includes(option.name.toLowerCase()) &&
          option.value.localeCompare(hint.value, undefined, { sensitivity: 'accent' }) === 0
        ) {
          matchingNames.add(option.name);
        }
      }
    }
    if (matchingNames.size === 1) selector[[...matchingNames][0]!] = [hint.value];
  }

  const entries = Object.entries(selector);
  if (entries.length === 0) return { variants, selector };
  return {
    variants: variants.filter((variant) =>
      entries.every(([name, values]) =>
        variant.options.some(
          (option) =>
            option.name === name &&
            values.some(
              (value) => option.value.localeCompare(value, undefined, { sensitivity: 'accent' }) === 0,
            ),
        ),
      ),
    ),
    selector,
  };
}

function catalogMapped(
  variants: ShopifyVariantIdentity[],
  source: NonNullable<CatalogResolution['source']>,
  confidence: number,
  evidence: Record<string, unknown>,
): CatalogResolution {
  return {
    state: 'MAPPED',
    variantIds: uniqueById(variants).map((variant) => variant.id),
    source,
    confidence,
    evidence: { resolverVersion: RESOLVER_VERSION, ...evidence },
  };
}

function catalogAmbiguous(evidence: Record<string, unknown>): CatalogResolution {
  return {
    state: 'AMBIGUOUS',
    variantIds: [],
    source: null,
    confidence: 0,
    evidence: { resolverVersion: RESOLVER_VERSION, ...evidence },
  };
}

export function resolveCatalogItem(
  item: CatalogItemIdentity,
  dataset: MappingDataset,
): CatalogResolution {
  const index = buildIndex(dataset);

  if (item.retailerId) {
    const candidates = resolveVariantToken(item.retailerId, index);
    if (candidates.length === 1) {
      return catalogMapped(candidates, 'RETAILER_ID_SKU', 1, {
        matchedBy: 'retailer_id',
        retailerId: item.retailerId,
      });
    }
    if (candidates.length > 1) {
      return catalogAmbiguous({
        matchedBy: 'retailer_id',
        retailerId: item.retailerId,
        reason: 'identifier_not_unique',
        candidateVariantIds: candidates.map((variant) => variant.id),
      });
    }
  }

  if (item.url) {
    const parsed = parseStoreUrl(item.url, index);
    if (parsed.kind === 'PRODUCT') {
      const productVariants = index.variantsByHandle.get(parsed.handle) ?? [];
      if (parsed.variantToken) {
        const variantCandidates = resolveVariantToken(parsed.variantToken, index).filter((variant) =>
          productVariants.some((productVariant) => productVariant.id === variant.id),
        );
        if (variantCandidates.length === 1) {
          return catalogMapped(variantCandidates, 'URL', 1, {
            matchedBy: 'product_url_variant',
            landingUrl: item.url,
            variantToken: parsed.variantToken,
          });
        }
        if (variantCandidates.length > 1) {
          return catalogAmbiguous({
            matchedBy: 'product_url_variant',
            landingUrl: item.url,
            reason: 'variant_not_unique',
          });
        }
      }

      if (productVariants.length > 0) {
        const narrowed = filterVariantsByCatalogHints(productVariants, item);
        if (narrowed.variants.length === 1) {
          return catalogMapped(narrowed.variants, 'URL', 0.99, {
            matchedBy: 'product_url_options',
            landingUrl: item.url,
            optionSelector: narrowed.selector,
          });
        }
        if (narrowed.variants.length > 1 && Object.keys(narrowed.selector).length > 0) {
          return catalogMapped(narrowed.variants, 'URL', 0.95, {
            matchedBy: 'product_url_partial_options',
            landingUrl: item.url,
            optionSelector: narrowed.selector,
          });
        }
        if (productVariants.length === 1) {
          return catalogMapped(productVariants, 'URL', 0.95, {
            matchedBy: 'single_variant_product_url',
            landingUrl: item.url,
          });
        }
      }
    }
  }

  for (const [field, token] of [
    ['retailer_product_group_id', item.retailerProductGroupId],
    ['parent_product_id', item.parentProductId],
  ] as const) {
    if (!token) continue;
    const productVariants = resolveProductToken(token, index);
    if (productVariants.length === 0) continue;
    const narrowed = filterVariantsByCatalogHints(productVariants, item);
    if (narrowed.variants.length === 1) {
      return catalogMapped(narrowed.variants, 'PRODUCT_GROUP', 0.95, {
        matchedBy: field,
        providerProductGroupId: token,
        optionSelector: narrowed.selector,
      });
    }
    if (narrowed.variants.length > 1 && Object.keys(narrowed.selector).length > 0) {
      return catalogMapped(narrowed.variants, 'PRODUCT_GROUP', 0.9, {
        matchedBy: field,
        providerProductGroupId: token,
        optionSelector: narrowed.selector,
      });
    }
    if (productVariants.length === 1) {
      return catalogMapped(productVariants, 'PRODUCT_GROUP', 0.9, {
        matchedBy: field,
        providerProductGroupId: token,
      });
    }
    return catalogAmbiguous({
      matchedBy: field,
      providerProductGroupId: token,
      reason: 'product_group_contains_multiple_variants_without_option_evidence',
    });
  }

  return {
    state: 'UNMAPPED',
    variantIds: [],
    source: null,
    confidence: 0,
    evidence: { resolverVersion: RESOLVER_VERSION, reason: 'no_deterministic_catalog_match' },
  };
}

function collectProviderIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderIds(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (PROVIDER_ID_KEYS.has(normalizedKey)) {
      const values = Array.isArray(child) ? child : [child];
      for (const candidate of values) {
        if (typeof candidate === 'string' || typeof candidate === 'number') {
          const token = String(candidate).trim();
          if (token) found.add(token);
        }
      }
    }
    collectProviderIds(child, found);
  }
  return found;
}

function destinationUrls(ad: MetaAdIdentity): string[] {
  const values: string[] = [];
  const creative = ad.creative;
  if (!creative) return values;
  for (const value of [
    creative.linkUrl,
    creative.linkDeepLinkUrl,
    creative.objectUrl,
    creative.templateUrl,
  ]) {
    if (value) values.push(value);
  }
  if (Array.isArray(creative.resolvedDestinationUrls)) {
    for (const value of creative.resolvedDestinationUrls) {
      if (typeof value === 'string' && value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function commonOptionSelector(variants: ShopifyVariantIdentity[]): Record<string, string[]> | null {
  if (variants.length < 2) return null;
  const names = new Set(variants.flatMap((variant) => variant.options.map((option) => option.name)));
  const selector: Record<string, string[]> = {};
  for (const name of names) {
    const values = new Set<string>();
    let presentInEveryVariant = true;
    for (const variant of variants) {
      const option = variant.options.find((candidate) => candidate.name === name);
      if (!option) {
        presentInEveryVariant = false;
        break;
      }
      values.add(option.value);
    }
    if (presentInEveryVariant && values.size === 1) selector[name] = [[...values][0]!];
  }
  return Object.keys(selector).length > 0 ? selector : null;
}

function mappingsFromVariants(
  variants: ShopifyVariantIdentity[],
  source: DesiredAdMapping['source'],
  confidence: number,
  evidence: Record<string, unknown>,
  options?: {
    catalogItemIds?: string[];
    landingUrl?: string | null;
    providerProductId?: string | null;
    providerProductGroupId?: string | null;
  },
): { scope: AdResolution['scope']; mappings: DesiredAdMapping[] } {
  const uniqueVariants = uniqueById(variants);
  const byProduct = new Map<string, ShopifyVariantIdentity[]>();
  for (const variant of uniqueVariants) addMulti(byProduct, variant.productId, variant);

  if (byProduct.size > 1) {
    return {
      scope: 'MULTI_PRODUCT',
      mappings: [...byProduct.entries()].map(([productId, productVariants]) => ({
        productId,
        variantId: null,
        catalogItemId: null,
        granularity: 'PRODUCT',
        optionSelector: null,
        source,
        confidence,
        landingUrl: options?.landingUrl ?? null,
        providerProductId: options?.providerProductId ?? null,
        providerProductGroupId: options?.providerProductGroupId ?? null,
        evidence: { ...evidence, variantIds: productVariants.map((variant) => variant.id) },
      })),
    };
  }

  const [productId, productVariants] = [...byProduct.entries()][0] ?? [];
  if (!productId || !productVariants) return { scope: 'UNKNOWN', mappings: [] };
  if (productVariants.length === 1) {
    return {
      scope: 'VARIANT',
      mappings: [
        {
          productId,
          variantId: productVariants[0]!.id,
          catalogItemId: options?.catalogItemIds?.length === 1 ? options.catalogItemIds[0]! : null,
          granularity: 'VARIANT',
          optionSelector: null,
          source,
          confidence,
          landingUrl: options?.landingUrl ?? null,
          providerProductId: options?.providerProductId ?? null,
          providerProductGroupId: options?.providerProductGroupId ?? null,
          evidence,
        },
      ],
    };
  }

  const selector = commonOptionSelector(productVariants);
  const allProductVariants = uniqueVariants.every((variant) => variant.productId === productId)
    ? productVariants
    : [];
  const granularity: MappingGranularity = selector ? 'PRODUCT_OPTION' : 'PRODUCT';
  return {
    scope: selector ? 'PRODUCT_OPTION' : 'PRODUCT',
    mappings: [
      {
        productId,
        variantId: null,
        catalogItemId: options?.catalogItemIds?.length === 1 ? options.catalogItemIds[0]! : null,
        granularity,
        optionSelector: selector,
        source,
        confidence,
        landingUrl: options?.landingUrl ?? null,
        providerProductId: options?.providerProductId ?? null,
        providerProductGroupId: options?.providerProductGroupId ?? null,
        evidence: {
          ...evidence,
          matchedVariantIds: allProductVariants.map((variant) => variant.id),
        },
      },
    ],
  };
}

function mappingsFromProductVariants(
  variants: ShopifyVariantIdentity[],
  source: DesiredAdMapping['source'],
  confidence: number,
  evidence: Record<string, unknown>,
  landingUrl: string | null,
): { scope: AdResolution['scope']; mappings: DesiredAdMapping[] } {
  const products = new Map<string, ShopifyVariantIdentity[]>();
  for (const variant of variants) addMulti(products, variant.productId, variant);
  if (products.size === 0) return { scope: 'UNKNOWN', mappings: [] };
  if (products.size > 1) {
    return {
      scope: 'MULTI_PRODUCT',
      mappings: [...products.keys()].map((productId) => ({
        productId,
        variantId: null,
        catalogItemId: null,
        granularity: 'PRODUCT',
        optionSelector: null,
        source,
        confidence,
        landingUrl,
        providerProductId: null,
        providerProductGroupId: null,
        evidence,
      })),
    };
  }
  const productId = [...products.keys()][0]!;
  return {
    scope: 'PRODUCT',
    mappings: [
      {
        productId,
        variantId: null,
        catalogItemId: null,
        granularity: 'PRODUCT',
        optionSelector: null,
        source,
        confidence,
        landingUrl,
        providerProductId: null,
        providerProductGroupId: null,
        evidence,
      },
    ],
  };
}

function parseUrlTagIds(urlTags: string | null): string[] {
  if (!urlTags) return [];
  try {
    const params = new URLSearchParams(urlTags.replace(/^\?/, ''));
    const keys = ['variant', 'variant_id', 'product_id', 'sku', 'retailer_id', 'content_id'];
    return keys.flatMap((key) => params.getAll(key)).filter(Boolean);
  } catch {
    return [];
  }
}

function textSuggestions(ad: MetaAdIdentity, index: ResolverIndex): AdSuggestion[] {
  const fields = [ad.name, ad.creative?.title, ad.creative?.body]
    .filter((value): value is string => Boolean(value))
    .map(normalizeText)
    .filter(Boolean);
  const suggestions: AdSuggestion[] = [];
  for (const product of index.productTitles) {
    if (product.normalized.length < 4) continue;
    const exact = fields.some((field) => field === product.normalized);
    const contained = fields.some((field) => field.includes(product.normalized));
    if (!exact && !contained) continue;
    suggestions.push({
      productId: product.productId,
      productTitle: product.title,
      confidence: exact ? 0.75 : 0.65,
      source: 'CREATIVE_TEXT',
      evidence: { resolverVersion: RESOLVER_VERSION, matchedText: product.title, exact },
    });
  }
  return suggestions.sort((left, right) => right.confidence - left.confidence).slice(0, 5);
}

export function resolveAd(ad: MetaAdIdentity, dataset: MappingDataset): AdResolution {
  const index = buildIndex(dataset);
  const structuredIds = new Set<string>();
  for (const value of [
    ad.creative?.productData,
    ad.creative?.assetFeedSpec,
    ad.adSetPromotedObject,
    ad.campaignPromotedObject,
  ]) {
    collectProviderIds(value, structuredIds);
  }

  if (structuredIds.size > 0) {
    const matchedItems = uniqueById(
      [...structuredIds].flatMap((providerId) => index.catalogItemsByProviderId.get(providerId) ?? []),
    );
    const mappedVariants = uniqueById(
      matchedItems.flatMap((item) =>
        item.activeMappings.flatMap((mapping) => {
          const variant = index.variantsById.get(mapping.variantId);
          return variant ? [variant] : [];
        }),
      ),
    );
    if (mappedVariants.length > 0) {
      const minCatalogConfidence = Math.min(
        ...matchedItems.flatMap((item) => item.activeMappings.map((mapping) => mapping.confidence)),
      );
      const resolved = mappingsFromVariants(
        mappedVariants,
        'CATALOG_ITEM',
        Math.min(0.99, minCatalogConfidence),
        {
          resolverVersion: RESOLVER_VERSION,
          matchedBy: 'structured_catalog_identifier',
          providerIds: [...structuredIds],
          catalogItemIds: matchedItems.map((item) => item.id),
        },
        { catalogItemIds: matchedItems.map((item) => item.id) },
      );
      return {
        ...resolved,
        confidence: Math.min(0.99, minCatalogConfidence),
        evidence: resolved.mappings[0]?.evidence ?? {
          resolverVersion: RESOLVER_VERSION,
          matchedBy: 'structured_catalog_identifier',
        },
        suggestions: [],
      };
    }
  }

  const urls = destinationUrls(ad);
  const urlVariantMatches: ShopifyVariantIdentity[] = [];
  const urlProductMatches: ShopifyVariantIdentity[] = [];
  const matchedProductUrls: string[] = [];
  let collectionUrl: string | null = null;
  let storeUrl: string | null = null;

  for (const rawUrl of urls) {
    const parsed = parseStoreUrl(rawUrl, index);
    if (parsed.kind === 'PRODUCT') {
      const productVariants = index.variantsByHandle.get(parsed.handle) ?? [];
      if (parsed.variantToken) {
        const variants = resolveVariantToken(parsed.variantToken, index).filter((variant) =>
          productVariants.some((candidate) => candidate.id === variant.id),
        );
        if (variants.length === 1) urlVariantMatches.push(variants[0]!);
      }
      if (productVariants.length > 0) {
        urlProductMatches.push(...productVariants);
        matchedProductUrls.push(rawUrl);
      }
    } else if (parsed.kind === 'COLLECTION') {
      collectionUrl ??= rawUrl;
    } else if (parsed.kind === 'STORE') {
      storeUrl ??= rawUrl;
    }
  }

  const exactUrlVariants = uniqueById(urlVariantMatches);
  if (exactUrlVariants.length > 0) {
    const resolved = mappingsFromVariants(
      exactUrlVariants,
      'URL',
      1,
      {
        resolverVersion: RESOLVER_VERSION,
        matchedBy: 'destination_variant_url',
        landingUrls: matchedProductUrls,
      },
      { landingUrl: matchedProductUrls[0] ?? null },
    );
    return {
      ...resolved,
      confidence: 1,
      evidence: resolved.mappings[0]?.evidence ?? {},
      suggestions: [],
    };
  }

  const productUrlVariants = uniqueById(urlProductMatches);
  if (productUrlVariants.length > 0) {
    const resolved = mappingsFromProductVariants(
      productUrlVariants,
      'URL',
      0.98,
      {
        resolverVersion: RESOLVER_VERSION,
        matchedBy: 'destination_product_url',
        landingUrls: matchedProductUrls,
      },
      matchedProductUrls[0] ?? null,
    );
    return {
      ...resolved,
      confidence: 0.98,
      evidence: resolved.mappings[0]?.evidence ?? {},
      suggestions: [],
    };
  }

  const tagIds = parseUrlTagIds(ad.creative?.urlTags ?? null);
  if (tagIds.length > 0) {
    const variants = uniqueById(tagIds.flatMap((token) => resolveVariantToken(token, index)));
    if (variants.length > 0) {
      const resolved = mappingsFromVariants(
        variants,
        'UTM',
        variants.length === 1 ? 0.99 : 0.95,
        {
          resolverVersion: RESOLVER_VERSION,
          matchedBy: 'url_tags_identifier',
          providerIds: tagIds,
        },
      );
      return {
        ...resolved,
        confidence: variants.length === 1 ? 0.99 : 0.95,
        evidence: resolved.mappings[0]?.evidence ?? {},
        suggestions: [],
      };
    }
  }

  if (ad.creative?.productSetId) {
    return {
      scope: 'MULTI_PRODUCT',
      confidence: 0.95,
      mappings: [],
      evidence: {
        resolverVersion: RESOLVER_VERSION,
        matchedBy: 'product_set',
        productSetId: ad.creative.productSetId,
      },
      suggestions: [],
    };
  }

  if (collectionUrl) {
    return {
      scope: 'COLLECTION',
      confidence: 0.95,
      mappings: [],
      evidence: {
        resolverVersion: RESOLVER_VERSION,
        matchedBy: 'collection_destination',
        landingUrl: collectionUrl,
      },
      suggestions: [],
    };
  }

  if (storeUrl) {
    return {
      scope: 'STORE',
      confidence: 0.9,
      mappings: [],
      evidence: {
        resolverVersion: RESOLVER_VERSION,
        matchedBy: 'storefront_destination',
        landingUrl: storeUrl,
      },
      suggestions: [],
    };
  }

  const suggestions = textSuggestions(ad, index);
  return {
    scope: 'UNKNOWN',
    confidence: 0,
    mappings: [],
    evidence: {
      resolverVersion: RESOLVER_VERSION,
      reason: suggestions.length > 0 ? 'text_suggestion_requires_review' : 'no_deterministic_ad_match',
    },
    suggestions,
  };
}

export function deriveScopeFromMappings(
  mappings: Array<{
    productId: string;
    variantId: string | null;
    granularity: MappingGranularity;
  }>,
): AdResolution['scope'] {
  if (mappings.length === 0) return 'UNKNOWN';
  const products = new Set(mappings.map((mapping) => mapping.productId));
  if (products.size > 1) return 'MULTI_PRODUCT';
  if (mappings.some((mapping) => mapping.granularity === 'PRODUCT_OPTION')) return 'PRODUCT_OPTION';
  if (mappings.length === 1 && mappings[0]!.granularity === 'VARIANT' && mappings[0]!.variantId) {
    return 'VARIANT';
  }
  return 'PRODUCT';
}
