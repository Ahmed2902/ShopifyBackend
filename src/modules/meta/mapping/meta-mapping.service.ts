import { AppError } from '../../../errors/app-error.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import { deriveScopeFromMappings, resolveAd, resolveCatalogItem } from './meta-mapping.resolver.js';
import type {
  ManualAdMappingInput,
  MetaMappingRepository,
} from './meta-mapping.repository.js';
import type { MappingDataset } from './meta-mapping.types.js';

const MAPPING_RESOURCE = 'ShopifyMappings';
const SCOPE_COUNTER = {
  VARIANT: 'variant',
  PRODUCT_OPTION: 'productOption',
  PRODUCT: 'product',
  MULTI_PRODUCT: 'multiProduct',
  COLLECTION: 'collection',
  STORE: 'store',
  UNKNOWN: 'unknown',
} as const;

export class MetaMappingService {
  constructor(
    private readonly repository: MetaMappingRepository,
    private readonly integrationService: IntegrationService,
  ) {}

  async resolveStoreMappings(storeId: string) {
    const dataset = await this.requireDataset(storeId);
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
        const confirmed = ad.activeMappings.filter((mapping) => mapping.isMerchantConfirmed);
        if (confirmed.length > 0) {
          const applied = await this.repository.applyAutomaticAdResolution(ad.id, {
            scope: 'UNKNOWN',
            confidence: 0,
            mappings: [],
            evidence: { reason: 'merchant_confirmed_mapping_preserved' },
            suggestions: [],
          });
          if (applied.changed) ads.changed += 1;
          ads.preservedConfirmed += 1;
          ads[SCOPE_COUNTER[deriveScopeFromMappings(confirmed)]] += 1;
          continue;
        }

        const resolution = resolveAd(ad, dataset);
        const applied = await this.repository.applyAutomaticAdResolution(ad.id, resolution);
        if (applied.changed) ads.changed += 1;
        ads[SCOPE_COUNTER[resolution.scope]] += 1;
        if (resolution.scope === 'UNKNOWN' && resolution.suggestions.length > 0) ads.needsReview += 1;
      }

      const recordsRead = dataset.catalogItems.length + dataset.ads.length;
      const recordsWritten = catalog.changed + ads.changed;
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
      })),
    };
  }

  mappingSummary(storeId: string) {
    return this.repository.mappingSummary(storeId);
  }

  async suggestions(storeId: string, metaAdId: string) {
    const dataset = await this.requireDataset(storeId);
    const ad = dataset.ads.find((candidate) => candidate.metaAdId === metaAdId);
    if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
    const confirmed = ad.activeMappings.filter((mapping) => mapping.isMerchantConfirmed);
    if (confirmed.length > 0) {
      return {
        metaAdId,
        currentScope: deriveScopeFromMappings(confirmed),
        merchantConfirmed: true,
        suggestions: [],
      };
    }
    const resolution = resolveAd(ad, dataset);
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

  replaceManualAdMappings(storeId: string, metaAdId: string, mappings: ManualAdMappingInput[]) {
    return this.repository.replaceManualAdMappings(storeId, metaAdId, mappings);
  }

  confirmCurrentAdMappings(storeId: string, metaAdId: string) {
    return this.repository.confirmCurrentAdMappings(storeId, metaAdId);
  }

  replaceManualCatalogMappings(storeId: string, metaProductItemId: string, variantIds: string[]) {
    return this.repository.replaceManualCatalogMappings(storeId, metaProductItemId, variantIds);
  }

  private async requireDataset(storeId: string): Promise<MappingDataset> {
    const dataset = await this.repository.loadDataset(storeId);
    if (!dataset) throw new AppError('Meta is not connected for this store', 409, 'META_NOT_CONNECTED');
    return dataset;
  }
}
