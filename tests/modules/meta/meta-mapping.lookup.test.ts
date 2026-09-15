import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import type { MetaCollectionMappingRepository } from '../../../src/modules/meta/mapping/meta-collection-mapping.repository.js';
import { MetaAdMappingLookup } from '../../../src/modules/meta/mapping/meta-mapping.lookup.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function build(options?: { found?: boolean }) {
  const found = options?.found ?? true;
  const findUnique = vi.fn().mockResolvedValue({ selectedAdAccountIds: ['act-selected'] });
  const findFirst = vi.fn().mockResolvedValue(found ? {
    metaAdId: 'meta-ad-1',
    name: 'Hoodie ad',
    targetScope: 'PRODUCT',
    targetScopeConfidence: '0.9',
    targetScopeEvidence: { source: 'landing_url' },
    effectiveStatus: 'ACTIVE',
    creative: { thumbnailUrl: null, title: 'Hoodie', productSetId: null },
    productMappings: [{
      id: 'product-map-1',
      granularity: 'PRODUCT',
      optionSelector: null,
      source: 'URL_EXACT',
      confidence: '0.9',
      evidenceJson: null,
      landingUrl: 'https://store.test/products/hoodie',
      isMerchantConfirmed: false,
      product: { id: 'product-1', shopifyProductId: 'gid://shopify/Product/1', title: 'Hoodie', handle: 'hoodie' },
      variant: null,
      catalogItem: null,
    }],
  } : null);
  const db = {
    metaConnection: { findUnique },
    metaAd: { findFirst },
  } as unknown as Pick<PrismaClient, 'metaConnection' | 'metaAd'>;

  const getActiveForExternalAds = vi.fn().mockResolvedValue(found ? [{
    id: 'collection-map-1',
    metaAdId: 'ad-local-1',
    collectionId: 'collection-1',
    source: 'MANUAL',
    confidence: '1',
    evidenceJson: null,
    landingUrl: null,
    isMerchantConfirmed: true,
    collection: {
      id: 'collection-1',
      shopifyCollectionId: 'gid://shopify/Collection/1',
      title: 'Summer',
      handle: 'summer',
      deletedAt: null,
    },
    ad: { metaAdId: 'meta-ad-1' },
  }] : []);
  const collections = {
    getActiveForExternalAds,
  } as unknown as Pick<MetaCollectionMappingRepository, 'getActiveForExternalAds'>;

  return {
    findUnique,
    findFirst,
    getActiveForExternalAds,
    lookup: new MetaAdMappingLookup(db, collections),
  };
}

describe('MetaAdMappingLookup', () => {
  it('point-reads one ad inside the store selected-account boundary and normalizes mapping confidence', async () => {
    const { lookup, findFirst, getActiveForExternalAds } = build();

    const result = await lookup.find(storeId, 'meta-ad-1');

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        metaAdId: 'meta-ad-1',
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: ['act-selected'] } },
      },
    }));
    expect(getActiveForExternalAds).toHaveBeenCalledWith(storeId, ['meta-ad-1']);
    expect(result).toMatchObject({
      metaAdId: 'meta-ad-1',
      targetScopeConfidence: 0.9,
      productMappings: [{ confidence: 0.9 }],
      collectionMappings: [{ confidence: 1, collection: { title: 'Summer' } }],
    });
  });

  it('returns META_AD_NOT_FOUND without loading collection mappings when the ad is not selected for the store', async () => {
    const { lookup, getActiveForExternalAds } = build({ found: false });

    await expect(lookup.find(storeId, 'missing-ad')).rejects.toMatchObject({
      statusCode: 404,
      code: 'META_AD_NOT_FOUND',
    });
    expect(getActiveForExternalAds).not.toHaveBeenCalled();
  });
});
