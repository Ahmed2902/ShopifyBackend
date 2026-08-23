import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
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

function build(options?: { failAdWrite?: boolean; data?: MappingDataset | null }) {
  const data = options && 'data' in options ? options.data : dataset();
  const repository = {
    loadDataset: vi.fn().mockResolvedValue(data),
    applyAutomaticCatalogResolution: vi.fn().mockResolvedValue({ state: 'MAPPED', changed: true }),
    applyAutomaticAdResolution: options?.failAdWrite
      ? vi.fn().mockRejectedValue(new Error('db failed'))
      : vi.fn().mockResolvedValue({ state: 'VARIANT', changed: true, scope: 'VARIANT' }),
    listAdMappings: vi.fn(),
    mappingSummary: vi.fn(),
    replaceManualAdMappings: vi.fn(),
    confirmCurrentAdMappings: vi.fn(),
    replaceManualCatalogMappings: vi.fn(),
  } as unknown as MetaMappingRepository;
  const integrationService = {
    startSyncRun: vi.fn().mockResolvedValue({ id: syncRunId }),
    completeSyncRun: vi.fn().mockResolvedValue(undefined),
    failSyncRun: vi.fn().mockResolvedValue(undefined),
    recordExternalPayload: vi.fn().mockResolvedValue(undefined),
  } as unknown as IntegrationService;
  return {
    repository,
    integrationService,
    service: new MetaMappingService(repository, integrationService),
  };
}

describe('MetaMappingService', () => {
  it('resolves catalog identity before ads so structured catalog evidence can map the ad', async () => {
    const { repository, integrationService, service } = build();

    const result = await service.resolveStoreMappings(storeId);

    expect(repository.applyAutomaticCatalogResolution).toHaveBeenCalledWith(
      'catalog-item-local',
      expect.objectContaining({ state: 'MAPPED', variantIds: ['variant-1'] }),
    );
    expect(repository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      'ad-local',
      expect.objectContaining({
        scope: 'VARIANT',
        mappings: [expect.objectContaining({ variantId: 'variant-1', source: 'CATALOG_ITEM' })],
      }),
    );
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

  it('preserves merchant-confirmed ad mappings instead of running an automatic replacement', async () => {
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
    const { repository, service } = build({ data });

    const result = await service.resolveStoreMappings(storeId);

    expect(repository.applyAutomaticAdResolution).toHaveBeenCalledWith(
      'ad-local',
      expect.objectContaining({ scope: 'UNKNOWN', mappings: [] }),
    );
    expect(result.breakdown.ads).toMatchObject({ preservedConfirmed: 1, variant: 1 });
  });

  it('fails the derived SyncRun when mapping persistence fails', async () => {
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
});
