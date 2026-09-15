import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import type { MetaCollectionMappingRepository } from '../../../src/modules/meta/mapping/meta-collection-mapping.repository.js';
import { MetaAdMappingLookup } from '../../../src/modules/meta/mapping/meta-mapping.lookup.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function build(found = true) {
  const findUnique = vi.fn().mockResolvedValue({ selectedAdAccountIds: ['act-selected'] });
  const findFirst = vi.fn().mockResolvedValue(found ? {
    id: 'ad-local-1',
    metaAdId: 'meta-ad-1',
    name: 'Hoodie ad',
    targetScope: 'PRODUCT',
    targetScopeConfidence: '0.9',
    targetScopeEvidence: null,
    effectiveStatus: 'ACTIVE',
    creative: null,
    productMappings: [],
  } : null);
  const db = {
    metaConnection: { findUnique },
    metaAd: { findFirst },
  } as unknown as Pick<PrismaClient, 'metaConnection' | 'metaAd'>;

  const getActiveForAds = vi.fn().mockResolvedValue(found ? [{
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
      shopifyCollectionId: 'shopify-collection-1',
      title: 'Summer',
      handle: 'summer',
      deletedAt: null,
    },
  }] : []);
  const collections = { getActiveForAds } as unknown as Pick<MetaCollectionMappingRepository, 'getActiveForAds'>;

  return { findFirst, getActiveForAds, lookup: new MetaAdMappingLookup(db, collections) };
}

describe('MetaAdMappingLookup', () => {
  it('reads within the selected-account boundary and binds collections to the authorized internal ad row', async () => {
    const { lookup, findFirst, getActiveForAds } = build();
    const result = await lookup.find(storeId, 'meta-ad-1');

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        metaAdId: 'meta-ad-1',
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: ['act-selected'] } },
      },
    }));
    expect(getActiveForAds).toHaveBeenCalledWith(['ad-local-1']);
    expect(result).not.toHaveProperty('id');
    expect(result).toMatchObject({
      metaAdId: 'meta-ad-1',
      targetScopeConfidence: 0.9,
      collectionMappings: [{ confidence: 1, collection: { title: 'Summer' } }],
    });
  });

  it('returns META_AD_NOT_FOUND without loading collection mappings when the ad is unavailable', async () => {
    const { lookup, getActiveForAds } = build(false);

    await expect(lookup.find(storeId, 'missing-ad')).rejects.toMatchObject({
      statusCode: 404,
      code: 'META_AD_NOT_FOUND',
    });
    expect(getActiveForAds).not.toHaveBeenCalled();
  });
});
