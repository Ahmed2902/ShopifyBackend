import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { MetaCollectionMappingRepository } from '../../../src/modules/meta/mapping/meta-collection-mapping.repository.js';
import type { MetaMappingRepository } from '../../../src/modules/meta/mapping/meta-mapping.repository.js';
import { MetaMappingService } from '../../../src/modules/meta/mapping/meta-mapping.service.js';
import type { MappingDataset } from '../../../src/modules/meta/mapping/meta-mapping.types.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syncRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function dataset(): MappingDataset {
  return {
    connectionId,
    store: { myshopifyDomain: 'store.myshopify.com', primaryDomainHost: 'store.test' },
    variants: [
      {
        id: 'variant-1',
        shopifyVariantId: 'gid://shopify/ProductVariant/101',
        sku: 'SKU-101',
        productId: 'product-1',
        shopifyProductId: 'gid://shopify/Product/10',
        productHandle: 'hoodie',
        productTitle: 'Hoodie',
        options: [{ name: 'Color', value: 'Black' }],
      },
    ],
    catalogItems: [
      {
        id: 'catalog-item-local',
        metaProductItemId: 'meta-item-1',
        retailerId: 'SKU-101',
        retailerProductGroupId: null,
        parentProductId: null,
        url: null,
        color: 'Black',
        size: null,
        pattern: null,
        name: 'Hoodie Black',
        activeMappings: [],
      },
    ],
    ads: [
      {
        id: 'ad-local',
        metaAdId: 'meta-ad-1',
        name: 'Hoodie ad',
        creative: {
          id: 'creative-local',
          productSetId: null,
          productData: { retailer_id: 'SKU-101' },
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
      },
    ],
  };
}

function collectionAd(data: MappingDataset, handle: string) {
  data.catalogItems = [];
  data.ads[0]!.creative!.productData = null;
  data.ads[0]!.creative!.linkUrl = `https://store.myshopify.com/collections/${handle}`;
  return data;
}

function build(options?: {
  failAdWrite?: boolean;
  data?: MappingDataset | null;
  collections?: Array<{
    id: string;
    shopifyCollectionId: string;
    title: string;
    handle: string | null;
  }>;
  activeCollectionMappings?: Array<Record<string, unknown>>;
}) {
  const data = options && 'data' in options ? options.data : dataset();
  const repository = {
    loadDataset: vi.fn().mockResolvedValue(data),
    applyAutomaticCatalogResolution: vi.fn().mockResolvedValue({ state: 'MAPPED', changed: true }),
    applyAutomaticAdResolution: vi.fn(),
    listAdMappings: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    mappingSummary: vi.fn().mockResolvedValue({ totalAds: 0, scopes: {}, merchantConfirmedMappings: 0 }),
    validateManualAdMappings: vi.fn().mockResolvedValue(undefined),
    replaceManualAdMappings: vi.fn().mockResolvedValue({ metaAdId: 'meta-ad-1' }),
    confirmCurrentAdMappings: vi.fn().mockResolvedValue({ metaAdId: 'meta-ad-1', confirmed: 1 }),
    replaceManualCatalogMappings: vi.fn(),
  } as unknown as MetaMappingRepository;
  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;
  const collectionRepository = {
    getStoreCollections: vi.fn().mockResolvedValue(options?.collections ?? []),
    getActiveForAds: vi.fn().mockResolvedValue(options?.activeCollectionMappings ?? []),
    getActiveForExternalAds: vi.fn().mockResolvedValue([]),
    applyAutomaticAdResolution: options?.failAdWrite
      ? vi.fn().mockRejectedValue(new Error('db failed'))
      : vi.fn().mockImplementation(({ resolution }) =>
          Promise.resolve({ state: resolution.scope, scope: resolution.scope, changed: true }),
        ),
    syncAutomaticMapping: vi.fn().mockResolvedValue({ state: 'UNLINKED', changed: false }),
    clearProductMappingsForInternalAd: vi.fn().mockResolvedValue({ count: 0 }),
    clearActiveForAd: vi.fn().mockResolvedValue({ changed: false }),
    replaceManualProductMappings: vi.fn().mockResolvedValue({
      metaAdId: 'meta-ad-1',
      scope: 'VARIANT',
    }),
    replaceManualMappings: vi.fn().mockResolvedValue({ metaAdId: 'meta-ad-1', scope: 'COLLECTION' }),
    confirmCurrentMappings: vi.fn().mockResolvedValue(null),
    countConfirmedForStore: vi.fn().mockResolvedValue(0),
  } as unknown as MetaCollectionMappingRepository;
  return {
    repository,
    integrationService,
    collectionRepository,
    service: new MetaMappingService(repository, integrationService, collectionRepository),
  };
}

describe('MetaMappingService', () => {
  it('resolves catalog identity before ads so structured catalog evidence can map the ad atomically', async () => {
    const { repository, collectionRepository, integrationService, service } = build();

    const result = await service.resolveStoreMappings(storeId);

    expect(repository.applyAutomaticCatalogResolution).toHaveBeenCalledWith(
      'catalog-item-local',
      expect.objectContaining({ state: 'MAPPED', variantIds: ['variant-1'] }),
    );
    expect(collectionRepository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: 'ad-local',
        collection: null,
        resolution: expect.objectContaining({
          scope: 'VARIANT',
          mappings: [expect.objectContaining({ variantId: 'variant-1', source: 'CATALOG_ITEM' })],
        }),
      }),
    );
    expect(repository.applyAutomaticAdResolution).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      resourceType: 'ShopifyMappings',
      recordsRead: 2,
      recordsWritten: 2,
      breakdown: {
        catalog: { mapped: 1 },
        ads: { variant: 1 },
      },
    });
    expect(integrationService.startSyncRun).toHaveBeenCalledWith({
      provider: 'META',
      connectionId,
      resourceType: 'ShopifyMappings',
      mode: 'DERIVED',
      apiVersion: 'internal-v1',
    });
    expect(integrationService.completeSyncRun).toHaveBeenCalledWith(syncRunId, {
      recordsRead: 2,
      recordsWritten: 2,
    });
  });

  it('automatically links a collection destination to the matching Shopify collection in the same target write', async () => {
    const data = collectionAd(dataset(), 'summer-drop');
    const collection = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      shopifyCollectionId: 'gid://shopify/Collection/1',
      title: 'Summer Drop',
      handle: 'summer-drop',
    };
    const { repository, collectionRepository, service } = build({
      data,
      collections: [collection],
    });

    await service.resolveStoreMappings(storeId);

    expect(collectionRepository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: 'ad-local',
        collection,
        resolution: expect.objectContaining({
          scope: 'COLLECTION',
          evidence: expect.objectContaining({
            collectionLinkage: 'LINKED',
            collection: expect.objectContaining({ id: collection.id, handle: 'summer-drop' }),
          }),
        }),
      }),
    );
    expect(repository.applyAutomaticAdResolution).not.toHaveBeenCalled();
  });

  it('retains collection scope without inventing a Shopify collection when the handle is unresolved', async () => {
    const data = collectionAd(dataset(), 'missing-drop');
    const { collectionRepository, service } = build({ data, collections: [] });

    await service.resolveStoreMappings(storeId);

    expect(collectionRepository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: 'ad-local',
        collection: null,
        resolution: expect.objectContaining({
          scope: 'COLLECTION',
          evidence: expect.objectContaining({
            collectionLinkage: 'UNRESOLVED',
            collection: null,
          }),
        }),
      }),
    );
  });

  it('preserves merchant-confirmed product mappings through the atomic target writer', async () => {
    const data = dataset();
    data.catalogItems = [];
    data.ads[0]!.activeMappings = [
      {
        id: 'confirmed-map',
        productId: 'product-1',
        variantId: 'variant-1',
        catalogItemId: null,
        granularity: 'VARIANT',
        optionSelector: null,
        source: 'MANUAL',
        confidence: 1,
        isMerchantConfirmed: true,
      },
    ];
    const { collectionRepository, service } = build({ data });

    const result = await service.resolveStoreMappings(storeId);

    expect(collectionRepository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: 'ad-local',
        resolution: expect.objectContaining({ scope: 'UNKNOWN', mappings: [] }),
      }),
    );
    expect(result.breakdown.ads).toMatchObject({ preservedConfirmed: 1, variant: 1 });
  });

  it('gives a merchant-confirmed collection target precedence over stale confirmed product mappings atomically', async () => {
    const data = dataset();
    data.catalogItems = [];
    data.ads[0]!.activeMappings = [
      {
        id: 'old-product-map',
        productId: 'product-1',
        variantId: null,
        catalogItemId: null,
        granularity: 'PRODUCT',
        optionSelector: null,
        source: 'MANUAL',
        confidence: 1,
        isMerchantConfirmed: true,
      },
    ];
    const collectionMapping = {
      id: 'collection-map',
      metaAdId: 'ad-local',
      collectionId: 'collection-local',
      source: 'MANUAL',
      confidence: 1,
      evidenceJson: null,
      landingUrl: null,
      isMerchantConfirmed: true,
      collection: {
        id: 'collection-local',
        shopifyCollectionId: 'gid://shopify/Collection/1',
        title: 'Summer Drop',
        handle: 'summer-drop',
        deletedAt: null,
      },
    };
    const { collectionRepository, service } = build({
      data,
      activeCollectionMappings: [collectionMapping],
    });

    const result = await service.resolveStoreMappings(storeId);

    expect(collectionRepository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: 'ad-local',
        resolution: expect.objectContaining({ scope: 'COLLECTION', confidence: 1, mappings: [] }),
      }),
    );
    expect(collectionRepository.clearProductMappingsForInternalAd).not.toHaveBeenCalled();
    expect(result.breakdown.ads).toMatchObject({ preservedConfirmed: 1, collection: 1 });
  });

  it('fails the derived SyncRun when the atomic target persistence fails', async () => {
    const { integrationService, service } = build({ failAdWrite: true });

    await expect(service.resolveStoreMappings(storeId)).rejects.toThrow('db failed');
    expect(integrationService.failSyncRun).toHaveBeenCalledWith(syncRunId, expect.anything());
    expect(integrationService.completeSyncRun).not.toHaveBeenCalled();
  });

  it('requires a Meta connection before starting a derived SyncRun', async () => {
    const { integrationService, service } = build({ data: null });

    await expect(service.resolveStoreMappings(storeId)).rejects.toMatchObject({
      code: 'META_NOT_CONNECTED',
    });
    expect(integrationService.startSyncRun).not.toHaveBeenCalled();
  });

  it('validates then atomically replaces manual product targets for a selected Meta ad', async () => {
    const { repository, collectionRepository, service } = build();
    const mappings = [{ productId: 'product-1', variantId: 'variant-1', granularity: 'VARIANT' as const }];

    await service.replaceManualAdMappings(storeId, 'meta-ad-1', mappings);

    expect(repository.validateManualAdMappings).toHaveBeenCalledWith(storeId, mappings);
    expect(collectionRepository.replaceManualProductMappings).toHaveBeenCalledWith(
      storeId,
      'meta-ad-1',
      mappings,
    );
    expect(repository.replaceManualAdMappings).not.toHaveBeenCalled();
    expect(collectionRepository.clearActiveForAd).not.toHaveBeenCalled();
  });

  it('routes manual collection replacement through the same selected-ad guard', async () => {
    const { collectionRepository, service } = build();
    const collectionIds = ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'];

    await service.replaceManualCollectionMappings(storeId, 'meta-ad-1', collectionIds);

    expect(collectionRepository.replaceManualMappings).toHaveBeenCalledWith(
      storeId,
      'meta-ad-1',
      collectionIds,
    );
  });

  it('rejects manual mapping changes for a deselected or stale Meta ad', async () => {
    const data = dataset();
    data.ads = [];
    const { repository, collectionRepository, service } = build({ data });

    await expect(
      service.replaceManualAdMappings(storeId, 'meta-ad-1', [
        { productId: 'product-1', variantId: 'variant-1', granularity: 'VARIANT' },
      ]),
    ).rejects.toMatchObject({ code: 'META_AD_NOT_FOUND' });
    expect(repository.validateManualAdMappings).not.toHaveBeenCalled();
    expect(collectionRepository.replaceManualProductMappings).not.toHaveBeenCalled();
  });

  it('rejects mapping confirmation for a deselected or stale Meta ad', async () => {
    const data = dataset();
    data.ads = [];
    const { repository, service } = build({ data });

    await expect(service.confirmCurrentAdMappings(storeId, 'meta-ad-1')).rejects.toMatchObject({
      code: 'META_AD_NOT_FOUND',
    });
    expect(repository.confirmCurrentAdMappings).not.toHaveBeenCalled();
  });
});
