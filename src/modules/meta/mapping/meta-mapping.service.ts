import { AppError } from '../../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../../lib/store-decision-cache.js';
import { integrationService, type IntegrationService } from '../../integrations/integration.service.js';
import { MetaCollectionMappingRepository } from './meta-collection-mapping.repository.js';
import { deriveScopeFromMappings, resolveAd, resolveCatalogItem } from './meta-mapping.resolver.js';
import {
  MetaMappingRepository,
  type ManualAdMappingInput,
} from './meta-mapping.repository.js';
import type { AdResolution, MappingDataset } from './meta-mapping.types.js';

const MAPPING_RESOURCE = 'ShopifyMappings';
const COLLECTION_PATH = /(?:^|\/)collections\/([^/?#]+)/i;
const SCOPE_COUNTER = {
  VARIANT: 'variant',
  PRODUCT_OPTION: 'productOption',
  PRODUCT: 'product',
  MULTI_PRODUCT: 'multiProduct',
  COLLECTION: 'collection',
  STORE: 'store',
  UNKNOWN: 'unknown',
} as const;

function collectionHandle(resolution: AdResolution): string | null {
  if (resolution.scope !== 'COLLECTION') return null;
  const raw = resolution.evidence.landingUrl;
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    const match = url.pathname.match(COLLECTION_PATH);
    return match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

export class MetaMappingService {
  constructor(
    private readonly repository: MetaMappingRepository,
    private readonly integrationService: IntegrationService,
    private readonly collectionRepository: MetaCollectionMappingRepository =
      new MetaCollectionMappingRepository(),
  ) {}

  async resolveStoreMappings(storeId: string) {
    const dataset = await this.requireDataset(storeId);
    const [collections, activeCollectionMappings] = await Promise.all([
      this.collectionRepository.getStoreCollections(storeId),
      this.collectionRepository.getActiveForAds(dataset.ads.map((ad) => ad.id)),
    ]);
    const collectionByHandle = new Map(
      collections
        .filter((collection) => collection.handle)
        .map((collection) => [collection.handle!.toLowerCase(), collection] as const),
    );
    const collectionMappingsByAd = new Map<string, typeof activeCollectionMappings>();
    for (const mapping of activeCollectionMappings) {
      const values = collectionMappingsByAd.get(mapping.metaAdId) ?? [];
      values.push(mapping);
      collectionMappingsByAd.set(mapping.metaAdId, values);
    }

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'META',
      connectionId: dataset.connectionId,
      resourceType: MAPPING_RESOURCE,
      mode: 'DERIVED',
      apiVersion: 'internal-v1',
    });

    try {
      const catalog = {
        scanned: dataset.catalogItems.length,
        mapped: 0,
        ambiguous: 0,
        unmapped: 0,
        preservedConfirmed: 0,
        changed: 0,
      };

      for (const item of dataset.catalogItems) {
        if (item.activeMappings.some((mapping) => mapping.isMerchantConfirmed)) {
          catalog.preservedConfirmed += 1;
          continue;
        }
        const resolution = resolveCatalogItem(item, dataset);
        const applied = await this.repository.applyAutomaticCatalogResolution(item.id, resolution);
        if (applied.changed) catalog.changed += 1;
        if (resolution.state === 'MAPPED') {
          catalog.mapped += 1;
          item.activeMappings = resolution.variantIds.map((variantId, index) => ({
            id: `derived:${item.id}:${variantId}:${index}`,
            variantId,
            source: resolution.source!,
            confidence: resolution.confidence,
            isMerchantConfirmed: false,
          }));
        } else {
          item.activeMappings = [];
          if (resolution.state === 'AMBIGUOUS') catalog.ambiguous += 1;
          else catalog.unmapped += 1;
        }
      }

      const ads = {
        scanned: dataset.ads.length,
        variant: 0,
        productOption: 0,
        product: 0,
        multiProduct: 0,
        collection: 0,
        store: 0,
        unknown: 0,
        needsReview: 0,
        preservedConfirmed: 0,
        changed: 0,
      };

      for (const ad of dataset.ads) {
        const confirmedCollections = (collectionMappingsByAd.get(ad.id) ?? []).filter(
          (mapping) => mapping.isMerchantConfirmed,
        );
        if (confirmedCollections.length > 0) {
          const resolution: AdResolution = {
            scope: 'COLLECTION',
            confidence: 1,
            mappings: [],
            evidence: {
              source: 'merchant_confirmation',
              collectionIds: confirmedCollections.map((mapping) => mapping.collectionId),
              mappingIds: confirmedCollections.map((mapping) => mapping.id),
            },
            suggestions: [],
          };
          const applied = await this.collectionRepository.applyAutomaticAdResolution({
            adId: ad.id,
            resolution,
            collection: null,
            landingUrl: null,
          });
          if (applied.changed) ads.changed += 1;
          ads.preservedConfirmed += 1;
          ads.collection += 1;
          continue;
        }

        const confirmed = ad.activeMappings.filter((mapping) => mapping.isMerchantConfirmed);
        if (confirmed.length > 0) {
          const applied = await this.collectionRepository.applyAutomaticAdResolution({
            adId: ad.id,
            resolution: {
              scope: 'UNKNOWN',
              confidence: 0,
              mappings: [],
              evidence: { reason: 'merchant_confirmed_mapping_preserved' },
              suggestions: [],
            },
            collection: null,
            landingUrl: null,
          });
          if (applied.changed) ads.changed += 1;
          ads.preservedConfirmed += 1;
          ads[SCOPE_COUNTER[deriveScopeFromMappings(confirmed)]] += 1;
          continue;
        }

        let resolution = resolveAd(ad, dataset);
        let linkedCollection = null as (typeof collections)[number] | null;
        let landingUrl: string | null = null;
        if (resolution.scope === 'COLLECTION') {
          landingUrl =
            typeof resolution.evidence.landingUrl === 'string'
              ? resolution.evidence.landingUrl
              : null;
          const handle = collectionHandle(resolution);
          linkedCollection = handle ? (collectionByHandle.get(handle) ?? null) : null;
          resolution = {
            ...resolution,
            evidence: {
              ...resolution.evidence,
              collectionLinkage: linkedCollection ? 'LINKED' : 'UNRESOLVED',
              collection: linkedCollection
                ? {
                    id: linkedCollection.id,
                    shopifyCollectionId: linkedCollection.shopifyCollectionId,
                    title: linkedCollection.title,
                    handle: linkedCollection.handle,
                  }
                : null,
            },
          };
        }

        const applied = await this.collectionRepository.applyAutomaticAdResolution({
          adId: ad.id,
          resolution,
          collection: linkedCollection,
          landingUrl,
        });
        if (applied.changed) ads.changed += 1;
        ads[SCOPE_COUNTER[resolution.scope]] += 1;
        if (resolution.scope === 'UNKNOWN' && resolution.suggestions.length > 0) ads.needsReview += 1;
      }

      const recordsRead = dataset.catalogItems.length + dataset.ads.length;
      const recordsWritten = catalog.changed + ads.changed;
      // completeSyncRun owns Store-generation invalidation for derived provider mutations.
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead, recordsWritten });
      await this.integrationService.recordExternalPayload({
        provider: 'META',
        resourceType: 'ShopifyMappingResolutionSummary',
        apiVersion: 'internal-v1',
        payload: { catalog, ads },
        syncRunId: syncRun.id,
      });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: MAPPING_RESOURCE,
        recordsRead,
        recordsWritten,
        breakdown: { catalog, ads },
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async listAdMappings(storeId: string, page: number, limit: number) {
    const result = await this.repository.listAdMappings(storeId, page, limit);
    const collectionMappings = await this.collectionRepository.getActiveForExternalAds(
      storeId,
      result.items.map((ad) => ad.metaAdId),
    );
    const byExternalAd = new Map<string, typeof collectionMappings>();
    for (const mapping of collectionMappings) {
      const values = byExternalAd.get(mapping.ad.metaAdId) ?? [];
      values.push(mapping);
      byExternalAd.set(mapping.ad.metaAdId, values);
    }

    return {
      ...result,
      page,
      limit,
      items: result.items.map((ad) => ({
        ...ad,
        targetScopeConfidence:
          ad.targetScopeConfidence == null ? null : Number(ad.targetScopeConfidence),
        productMappings: ad.productMappings.map((mapping) => ({
          ...mapping,
          confidence: Number(mapping.confidence),
        })),
        collectionMappings: (byExternalAd.get(ad.metaAdId) ?? []).map(
          ({ ad: _ad, metaAdId: _internalAdId, ...mapping }) => ({
            ...mapping,
            confidence: Number(mapping.confidence),
          }),
        ),
      })),
    };
  }

  async mappingSummary(storeId: string) {
    const [summary, confirmedCollections] = await Promise.all([
      this.repository.mappingSummary(storeId),
      this.collectionRepository.countConfirmedForStore(storeId),
    ]);
    return {
      ...summary,
      merchantConfirmedCollectionMappings: confirmedCollections,
    };
  }

  async suggestions(storeId: string, metaAdId: string) {
    const dataset = await this.requireDataset(storeId);
    const ad = dataset.ads.find((candidate) => candidate.metaAdId === metaAdId);
    if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
    const activeCollections = await this.collectionRepository.getActiveForAds([ad.id]);
    const confirmedCollections = activeCollections.filter((mapping) => mapping.isMerchantConfirmed);
    if (confirmedCollections.length > 0) {
      return {
        metaAdId,
        currentScope: 'COLLECTION' as const,
        merchantConfirmed: true,
        collections: confirmedCollections.map((mapping) => mapping.collection),
        suggestions: [],
      };
    }

    const confirmed = ad.activeMappings.filter((mapping) => mapping.isMerchantConfirmed);
    if (confirmed.length > 0) {
      return {
        metaAdId,
        currentScope: deriveScopeFromMappings(confirmed),
        merchantConfirmed: true,
        suggestions: [],
      };
    }

    let resolution = resolveAd(ad, dataset);
    if (resolution.scope === 'COLLECTION') {
      const collections = await this.collectionRepository.getStoreCollections(storeId);
      const handle = collectionHandle(resolution);
      const linked = handle
        ? collections.find((collection) => collection.handle?.toLowerCase() === handle) ?? null
        : null;
      resolution = {
        ...resolution,
        evidence: {
          ...resolution.evidence,
          collectionLinkage: linked ? 'LINKED' : 'UNRESOLVED',
          collection: linked,
        },
      };
    }

    return {
      metaAdId,
      currentScope: resolution.scope,
      confidence: resolution.confidence,
      deterministicMappings: resolution.mappings,
      evidence: resolution.evidence,
      suggestions: resolution.suggestions,
      merchantConfirmed: false,
    };
  }

  async replaceManualAdMappings(
    storeId: string,
    metaAdId: string,
    mappings: ManualAdMappingInput[],
  ) {
    await this.requireSelectedAd(storeId, metaAdId);
    await this.repository.validateManualAdMappings(storeId, mappings);
    const result = await this.collectionRepository.replaceManualProductMappings(storeId, metaAdId, mappings);
    await invalidateStoreDecisionCaches(storeId);
    return result;
  }

  async replaceManualCollectionMappings(
    storeId: string,
    metaAdId: string,
    collectionIds: string[],
  ) {
    await this.requireSelectedAd(storeId, metaAdId);
    const result = await this.collectionRepository.replaceManualMappings(storeId, metaAdId, collectionIds);
    await invalidateStoreDecisionCaches(storeId);
    return result;
  }

  async confirmCurrentAdMappings(storeId: string, metaAdId: string) {
    await this.requireSelectedAd(storeId, metaAdId);
    const collection = await this.collectionRepository.confirmCurrentMappings(storeId, metaAdId);
    if (collection) {
      await invalidateStoreDecisionCaches(storeId);
      return collection;
    }
    const result = await this.repository.confirmCurrentAdMappings(storeId, metaAdId);
    await invalidateStoreDecisionCaches(storeId);
    return result;
  }

  async replaceManualCatalogMappings(storeId: string, metaProductItemId: string, variantIds: string[]) {
    const result = await this.repository.replaceManualCatalogMappings(storeId, metaProductItemId, variantIds);
    await invalidateStoreDecisionCaches(storeId);
    return result;
  }

  private async requireSelectedAd(storeId: string, metaAdId: string): Promise<void> {
    const dataset = await this.requireDataset(storeId);
    if (!dataset.ads.some((ad) => ad.metaAdId === metaAdId)) {
      throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
    }
  }

  private async requireDataset(storeId: string): Promise<MappingDataset> {
    const dataset = await this.repository.loadDataset(storeId);
    if (!dataset) throw new AppError('Meta is not connected for this store', 409, 'META_NOT_CONNECTED');
    return dataset;
  }
}

export const metaMappingService = new MetaMappingService(
  new MetaMappingRepository(),
  integrationService,
  new MetaCollectionMappingRepository(),
);
