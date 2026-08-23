import { describe, expect, it } from 'vitest';
import { resolveAd, resolveCatalogItem } from '../../../src/modules/meta/mapping/meta-mapping.resolver.js';
import type {
  CatalogItemIdentity,
  MappingDataset,
  MetaAdIdentity,
} from '../../../src/modules/meta/mapping/meta-mapping.types.js';

function baseDataset(): MappingDataset {
  return {
    connectionId: 'connection-1',
    store: { myshopifyDomain: 'test-shop.myshopify.com', primaryDomainHost: 'shop.example.com' },
    variants: [
      {
        id: 'black-s',
        shopifyVariantId: 'gid://shopify/ProductVariant/101',
        sku: 'HOOD-BLK-S',
        productId: 'hoodie',
        shopifyProductId: 'gid://shopify/Product/10',
        productHandle: 'classic-hoodie',
        productTitle: 'Classic Hoodie',
        options: [
          { name: 'Color', value: 'Black' },
          { name: 'Size', value: 'S' },
        ],
      },
      {
        id: 'black-m',
        shopifyVariantId: 'gid://shopify/ProductVariant/102',
        sku: 'HOOD-BLK-M',
        productId: 'hoodie',
        shopifyProductId: 'gid://shopify/Product/10',
        productHandle: 'classic-hoodie',
        productTitle: 'Classic Hoodie',
        options: [
          { name: 'Color', value: 'Black' },
          { name: 'Size', value: 'M' },
        ],
      },
      {
        id: 'white-s',
        shopifyVariantId: 'gid://shopify/ProductVariant/103',
        sku: 'HOOD-WHT-S',
        productId: 'hoodie',
        shopifyProductId: 'gid://shopify/Product/10',
        productHandle: 'classic-hoodie',
        productTitle: 'Classic Hoodie',
        options: [
          { name: 'Color', value: 'White' },
          { name: 'Size', value: 'S' },
        ],
      },
      {
        id: 'cap-default',
        shopifyVariantId: 'gid://shopify/ProductVariant/201',
        sku: 'CAP-1',
        productId: 'cap',
        shopifyProductId: 'gid://shopify/Product/20',
        productHandle: 'classic-cap',
        productTitle: 'Classic Cap',
        options: [{ name: 'Title', value: 'Default Title' }],
      },
    ],
    catalogItems: [],
    ads: [],
  };
}

function catalog(overrides: Partial<CatalogItemIdentity> = {}): CatalogItemIdentity {
  return {
    id: 'catalog-local-1',
    metaProductItemId: 'meta-item-1',
    retailerId: null,
    retailerProductGroupId: null,
    parentProductId: null,
    url: null,
    color: null,
    size: null,
    pattern: null,
    name: null,
    activeMappings: [],
    ...overrides,
  };
}

function ad(overrides: Partial<MetaAdIdentity> = {}): MetaAdIdentity {
  return {
    id: 'ad-local-1',
    metaAdId: 'meta-ad-1',
    name: 'Prospecting',
    creative: {
      id: 'creative-1',
      productSetId: null,
      productData: null,
      assetFeedSpec: null,
      resolvedDestinationUrls: [],
      linkUrl: null,
      linkDeepLinkUrl: null,
      objectUrl: null,
      templateUrl: null,
      urlTags: null,
      title: null,
      body: null,
    },
    adSetPromotedObject: null,
    campaignPromotedObject: null,
    activeMappings: [],
    ...overrides,
  };
}

describe('Meta catalog → Shopify resolver', () => {
  it('maps an exact unique retailer/SKU identifier with full confidence', () => {
    const dataset = baseDataset();
    const result = resolveCatalogItem(catalog({ retailerId: 'HOOD-BLK-M' }), dataset);

    expect(result).toMatchObject({
      state: 'MAPPED',
      variantIds: ['black-m'],
      source: 'RETAILER_ID_SKU',
      confidence: 1,
    });
  });

  it('recognizes the common shopify_<product>_<variant> retailer identifier', () => {
    const dataset = baseDataset();
    const result = resolveCatalogItem(catalog({ retailerId: 'shopify_10_102' }), dataset);

    expect(result).toMatchObject({ state: 'MAPPED', variantIds: ['black-m'], confidence: 1 });
  });

  it('does not auto-map a duplicate SKU', () => {
    const dataset = baseDataset();
    dataset.variants.push({ ...dataset.variants[0]!, id: 'duplicate-sku' });

    const result = resolveCatalogItem(catalog({ retailerId: 'HOOD-BLK-S' }), dataset);

    expect(result.state).toBe('AMBIGUOUS');
    expect(result.variantIds).toEqual([]);
  });

  it('uses an exact Shopify variant query parameter when the host and product agree', () => {
    const dataset = baseDataset();
    const result = resolveCatalogItem(
      catalog({ url: 'https://shop.example.com/products/classic-hoodie?variant=103' }),
      dataset,
    );

    expect(result).toMatchObject({ state: 'MAPPED', variantIds: ['white-s'], source: 'URL' });
  });

  it('maps a partial product option without inventing a size', () => {
    const dataset = baseDataset();
    const result = resolveCatalogItem(
      catalog({ url: 'https://shop.example.com/products/classic-hoodie', color: 'Black' }),
      dataset,
    );

    expect(result).toMatchObject({ state: 'MAPPED', source: 'URL', confidence: 0.95 });
    expect(new Set(result.variantIds)).toEqual(new Set(['black-s', 'black-m']));
    expect(result.evidence).toMatchObject({ optionSelector: { Color: ['Black'] } });
  });

  it('does not guess one variant from a multi-variant product URL with no option evidence', () => {
    const dataset = baseDataset();
    const result = resolveCatalogItem(
      catalog({ url: 'https://shop.example.com/products/classic-hoodie' }),
      dataset,
    );

    expect(result.state).toBe('UNMAPPED');
  });
});

describe('Meta ad → Shopify resolver', () => {
  it('maps a destination URL with variant query to VARIANT', () => {
    const dataset = baseDataset();
    const result = resolveAd(
      ad({
        creative: {
          ...ad().creative!,
          linkUrl: 'https://shop.example.com/products/classic-hoodie?variant=102',
        },
      }),
      dataset,
    );

    expect(result.scope).toBe('VARIANT');
    expect(result.confidence).toBe(1);
    expect(result.mappings[0]).toMatchObject({ productId: 'hoodie', variantId: 'black-m' });
  });

  it('maps a product landing page to PRODUCT rather than an arbitrary variant', () => {
    const dataset = baseDataset();
    const result = resolveAd(
      ad({
        creative: {
          ...ad().creative!,
          linkUrl: 'https://shop.example.com/products/classic-hoodie',
        },
      }),
      dataset,
    );

    expect(result.scope).toBe('PRODUCT');
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]).toMatchObject({ productId: 'hoodie', variantId: null });
  });

  it('uses catalog-item evidence when structured creative IDs resolve to mapped catalog items', () => {
    const dataset = baseDataset();
    dataset.catalogItems = [
      catalog({
        metaProductItemId: 'meta-item-101',
        retailerId: 'HOOD-BLK-S',
        activeMappings: [
          {
            id: 'catalog-map-1',
            variantId: 'black-s',
            source: 'RETAILER_ID_SKU',
            confidence: 1,
            isMerchantConfirmed: false,
          },
        ],
      }),
    ];
    const result = resolveAd(
      ad({
        creative: {
          ...ad().creative!,
          productData: { retailer_id: 'HOOD-BLK-S' },
        },
      }),
      dataset,
    );

    expect(result.scope).toBe('VARIANT');
    expect(result.mappings[0]).toMatchObject({
      variantId: 'black-s',
      source: 'CATALOG_ITEM',
      catalogItemId: 'catalog-local-1',
    });
  });

  it('keeps a shared catalog option at PRODUCT_OPTION granularity instead of inventing a size', () => {
    const dataset = baseDataset();
    dataset.catalogItems = [
      catalog({
        id: 'catalog-black-s',
        metaProductItemId: 'meta-black-s',
        retailerId: 'HOOD-BLK-S',
        activeMappings: [
          {
            id: 'map-black-s',
            variantId: 'black-s',
            source: 'RETAILER_ID_SKU',
            confidence: 1,
            isMerchantConfirmed: false,
          },
        ],
      }),
      catalog({
        id: 'catalog-black-m',
        metaProductItemId: 'meta-black-m',
        retailerId: 'HOOD-BLK-M',
        activeMappings: [
          {
            id: 'map-black-m',
            variantId: 'black-m',
            source: 'RETAILER_ID_SKU',
            confidence: 1,
            isMerchantConfirmed: false,
          },
        ],
      }),
    ];

    const result = resolveAd(
      ad({
        creative: {
          ...ad().creative!,
          productData: { content_ids: ['meta-black-s', 'meta-black-m'] },
        },
      }),
      dataset,
    );

    expect(result.scope).toBe('PRODUCT_OPTION');
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]).toMatchObject({
      productId: 'hoodie',
      variantId: null,
      granularity: 'PRODUCT_OPTION',
      optionSelector: { Color: ['Black'] },
      source: 'CATALOG_ITEM',
    });
  });

  it('classifies a product-set ad as MULTI_PRODUCT without pretending to know a product', () => {
    const dataset = baseDataset();
    const result = resolveAd(
      ad({ creative: { ...ad().creative!, productSetId: 'set_1' } }),
      dataset,
    );

    expect(result).toMatchObject({ scope: 'MULTI_PRODUCT', confidence: 0.95, mappings: [] });
  });

  it('distinguishes collection and storefront destinations', () => {
    const dataset = baseDataset();
    const collectionResult = resolveAd(
      ad({ creative: { ...ad().creative!, linkUrl: 'https://shop.example.com/collections/summer' } }),
      dataset,
    );
    const storeResult = resolveAd(
      ad({ creative: { ...ad().creative!, linkUrl: 'https://shop.example.com/' } }),
      dataset,
    );

    expect(collectionResult.scope).toBe('COLLECTION');
    expect(storeResult.scope).toBe('STORE');
  });

  it('keeps text-only product matches as review suggestions instead of auto-mapping', () => {
    const dataset = baseDataset();
    const result = resolveAd(ad({ name: 'Classic Hoodie prospecting' }), dataset);

    expect(result.scope).toBe('UNKNOWN');
    expect(result.mappings).toEqual([]);
    expect(result.suggestions[0]).toMatchObject({
      productId: 'hoodie',
      source: 'CREATIVE_TEXT',
    });
  });
});
