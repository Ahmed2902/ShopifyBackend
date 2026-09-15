import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { MetaCollectionMappingRepository } from '../../../src/modules/meta/mapping/meta-collection-mapping.repository.js';
import type { MetaMappingRepository } from '../../../src/modules/meta/mapping/meta-mapping.repository.js';
import { MetaMappingService } from '../../../src/modules/meta/mapping/meta-mapping.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('MetaMappingService list contract', () => {
  it('does not expose the internal MetaAd foreign key on collection mappings', async () => {
    const repository = {
      listAdMappings: vi.fn().mockResolvedValue({
        total: 1,
        items: [{
          metaAdId: 'meta-ad-1',
          name: 'Ad',
          targetScope: 'COLLECTION',
          targetScopeConfidence: '1',
          targetScopeEvidence: null,
          effectiveStatus: 'ACTIVE',
          creative: null,
          productMappings: [],
        }],
      }),
    } as unknown as MetaMappingRepository;
    const collectionRepository = {
      getActiveForExternalAds: vi.fn().mockResolvedValue([{
        id: 'collection-map-1',
        metaAdId: 'internal-ad-uuid',
        collectionId: 'collection-1',
        source: 'MANUAL',
        confidence: '1',
        evidenceJson: null,
        landingUrl: null,
        isMerchantConfirmed: true,
        collection: { id: 'collection-1', title: 'Summer', handle: 'summer' },
        ad: { metaAdId: 'meta-ad-1' },
      }]),
    } as unknown as MetaCollectionMappingRepository;
    const integrationService = {} as IntegrationService;
    const service = new MetaMappingService(repository, integrationService, collectionRepository);

    const result = await service.listAdMappings(storeId, 1, 50);

    expect(result.items[0]?.collectionMappings[0]).not.toHaveProperty('metaAdId');
    expect(result.items[0]?.collectionMappings[0]).toMatchObject({
      id: 'collection-map-1',
      collectionId: 'collection-1',
      confidence: 1,
    });
  });
});
