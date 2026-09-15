import { describe, expect, it, vi } from 'vitest';
import type { MetaMappingService } from '../../../src/modules/meta/mapping/meta-mapping.service.js';
import { findSelectedMetaAdMapping } from '../../../src/modules/meta/mapping/meta-mapping.lookup.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(metaAdId: string) {
  return {
    metaAdId,
    name: `Ad ${metaAdId}`,
    targetScope: 'UNKNOWN' as const,
    targetScopeConfidence: 0,
    targetScopeEvidence: null,
    effectiveStatus: 'ACTIVE',
    creative: null,
    productMappings: [],
    collectionMappings: [],
  };
}

describe('findSelectedMetaAdMapping', () => {
  it('finds an ad beyond the first queue page without changing queue projection rules', async () => {
    const listAdMappings = vi
      .fn()
      .mockResolvedValueOnce({ items: [row('meta-ad-1')], total: 101, page: 1, limit: 100 })
      .mockResolvedValueOnce({ items: [row('meta-ad-101')], total: 101, page: 2, limit: 100 });
    const service = { listAdMappings } as unknown as Pick<MetaMappingService, 'listAdMappings'>;

    await expect(findSelectedMetaAdMapping(service, storeId, 'meta-ad-101')).resolves.toMatchObject({
      metaAdId: 'meta-ad-101',
    });
    expect(listAdMappings).toHaveBeenNthCalledWith(1, storeId, 1, 100);
    expect(listAdMappings).toHaveBeenNthCalledWith(2, storeId, 2, 100);
  });

  it('returns META_AD_NOT_FOUND after the selected mapping queue is exhausted', async () => {
    const listAdMappings = vi.fn().mockResolvedValue({
      items: [row('meta-ad-1')],
      total: 1,
      page: 1,
      limit: 100,
    });
    const service = { listAdMappings } as unknown as Pick<MetaMappingService, 'listAdMappings'>;

    await expect(findSelectedMetaAdMapping(service, storeId, 'missing-ad')).rejects.toMatchObject({
      statusCode: 404,
      code: 'META_AD_NOT_FOUND',
    });
    expect(listAdMappings).toHaveBeenCalledTimes(1);
  });
});
