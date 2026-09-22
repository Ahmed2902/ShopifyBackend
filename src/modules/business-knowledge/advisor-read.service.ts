import { adExposureWorkspace, type AdExposureWorkspace } from '../analytics/ad-exposure.workspace.js';
import { analyticsWorkspace, type AnalyticsWorkspace } from '../analytics/analytics.workspace.js';
import {
  collectionDetailReadService,
  type CollectionDetailReadService,
} from '../analytics/collection-detail.read.service.js';
import {
  performanceAnalyticsWorkspace,
  type PerformanceAnalyticsWorkspace,
} from '../analytics/performance-analytics.workspace.js';
import { productAdsWorkspace, type ProductAdsWorkspace } from '../analytics/product-ads.workspace.js';
import {
  productLeaderboardService,
  type ProductLeaderboardService,
} from '../analytics/product-leaderboard.service.js';
import { reportWorkspace, type ReportWorkspace } from '../analytics/report.workspace.js';
import { billingService, type BillingService } from '../billing/billing.service.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from '../intelligence/intelligence-snapshot.read.service.js';
import { intelligenceService, type IntelligenceService } from '../intelligence/intelligence.service.js';
import {
  inventoryPlanningService,
  type InventoryPlanningService,
} from '../intelligence/inventory-planning.service.js';
import { recommendationLifecycleService } from '../intelligence/recommendation-lifecycle.service.js';
import {
  pixelAttributionService,
  type PixelAttributionService,
} from '../pixel/attribution/pixel-attribution.service.js';
import {
  pixelBehaviorOverviewReadService,
  type PixelBehaviorOverviewReadService,
} from '../pixel/behavior/pixel-behavior-overview.read.service.js';
import { pixelBehaviorService, type PixelBehaviorService } from '../pixel/behavior/pixel-behavior.service.js';
import { pixelHealthService, type PixelHealthService } from '../pixel/pixel-health.service.js';
import { businessKnowledgeService, type BusinessKnowledgeService } from './business-knowledge.service.js';
import {
  paidMediaEvidenceRegistry,
  type PaidMediaEvidenceRegistry,
  type PaidMediaLevel,
  type PaidMediaProvider,
} from './paid-media-evidence.js';

export type AdvisorEntityType =
  | 'PRODUCT'
  | 'COLLECTION'
  | 'CAMPAIGN'
  | 'GROUP'
  | 'AD'
  | 'CREATIVE'
  | 'LANDING_PAGE'
  | 'ATTRIBUTION_SOURCE'
  | 'RECOMMENDATION';

interface AdvisorSearchResult {
  type: AdvisorEntityType;
  id: string | null;
  externalId: string | null;
  name: string;
  provider: PaidMediaProvider | 'STRIDE' | 'SHOPIFY' | 'PIXEL';
  evidence: unknown;
}

function listQuery(days: number, page = 1, limit = 50) {
  return { days, page, limit };
}

function normalizedDays(days = 30) {
  return Math.min(Math.max(Math.trunc(days), 1), 365);
}

function text(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function resultFromRow(
  type: AdvisorEntityType,
  row: unknown,
  provider: AdvisorSearchResult['provider'],
): AdvisorSearchResult {
  const object = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const nested =
    (object.entity && typeof object.entity === 'object' ? object.entity : null) ??
    (object.product && typeof object.product === 'object' ? object.product : null) ??
    (object.collection && typeof object.collection === 'object' ? object.collection : null) ??
    object;
  const entity = nested as Record<string, unknown>;
  const id = text(entity.id) ?? text(object.id) ?? text(object.dimensionKey);
  const externalId =
    text(entity.externalId) ??
    text(entity.shopifyProductId) ??
    text(entity.shopifyCollectionId) ??
    text(entity.externalEntityId) ??
    text(object.externalEntityId);
  const name =
    text(entity.name) ??
    text(entity.title) ??
    text(entity.handle) ??
    text(object.entityName) ??
    text(object.title) ??
    text(object.landingPageUrl) ??
    text(object.source) ??
    text(object.dimensionKey) ??
    externalId ??
    id ??
    type;
  return { type, id, externalId, name, provider, evidence: row };
}

function items(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.items)) return object.items;
  const evidence = object.evidence;
  if (evidence && typeof evidence === 'object') {
    const evidenceObject = evidence as Record<string, unknown>;
    if (Array.isArray(evidenceObject.items)) return evidenceObject.items;
    const hierarchy = evidenceObject.hierarchy;
    if (hierarchy && typeof hierarchy === 'object') {
      const hierarchyItems = (hierarchy as Record<string, unknown>).items;
      if (Array.isArray(hierarchyItems)) return hierarchyItems;
    }
  }
  return [];
}

function searchableEvidence(value: unknown) {
  try {
    return JSON.stringify(value, (_key, candidate) =>
      typeof candidate === 'bigint' ? candidate.toString() : candidate,
    );
  } catch {
    return '';
  }
}

/**
 * Complete protocol-independent read facade for advisor integrations.
 * No metric is recalculated here: every result comes from an existing Stride read model.
 */
export class AdvisorReadService {
  constructor(
    private readonly knowledge: BusinessKnowledgeService = businessKnowledgeService,
    private readonly analytics: AnalyticsWorkspace = analyticsWorkspace,
    private readonly productAds: ProductAdsWorkspace = productAdsWorkspace,
    private readonly reports: ReportWorkspace = reportWorkspace,
    private readonly intelligence: IntelligenceSnapshotReadService = intelligenceSnapshotReadService,
    private readonly storefront: PixelBehaviorService = pixelBehaviorService,
    private readonly attribution: PixelAttributionService = pixelAttributionService,
    private readonly paidMedia: PaidMediaEvidenceRegistry = paidMediaEvidenceRegistry,
    private readonly collectionDetails: CollectionDetailReadService = collectionDetailReadService,
    private readonly storefrontOverviewReads: PixelBehaviorOverviewReadService = pixelBehaviorOverviewReadService,
    private readonly performanceAnalytics: PerformanceAnalyticsWorkspace = performanceAnalyticsWorkspace,
    private readonly productLeaderboardReads: ProductLeaderboardService = productLeaderboardService,
    private readonly adExposure: AdExposureWorkspace = adExposureWorkspace,
    private readonly pixelHealth: PixelHealthService = pixelHealthService,
    private readonly billing: BillingService = billingService,
    private readonly intelligenceSettingsReads: IntelligenceService = intelligenceService,
    private readonly inventoryPlanningReads: InventoryPlanningService = inventoryPlanningService,
  ) {}

  context(storeId: string) {
    return this.knowledge.context(storeId);
  }

  snapshot(storeId: string, input: { days?: number; fresh?: boolean } = {}) {
    return this.knowledge.snapshot(storeId, input);
  }

  catalog() {
    return { ...this.knowledge.catalog(), paidMediaProviders: this.paidMedia.capabilities() };
  }

  overview(storeId: string, days = 30) {
    return this.analytics.overview(storeId, { days: normalizedDays(days) });
  }

  performance(storeId: string, days = 30) {
    return this.performanceAnalytics.daily(storeId, { days: normalizedDays(days) });
  }

  products(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.analytics.products(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  product(storeId: string, productId: string, days = 30) {
    return this.analytics.product(storeId, productId, { days: normalizedDays(days) });
  }

  productLeaderboard(storeId: string, input: { days?: number; limit?: number } = {}) {
    return this.productLeaderboardReads.read(storeId, {
      days: normalizedDays(input.days),
      limit: Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 100),
    });
  }

  collections(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.analytics.collections(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  collectionDetail(
    storeId: string,
    collectionId: string,
    input: { page?: number; limit?: number } = {},
  ) {
    return this.collectionDetails.read(storeId, collectionId, input.page ?? 1, input.limit ?? 50);
  }

  customers(storeId: string, days = 30) {
    return this.analytics.customers(storeId, { days: normalizedDays(days) });
  }

  inventory(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.analytics.inventory(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  paidMediaOverview(storeId: string, provider: PaidMediaProvider, days = 30) {
    return this.paidMedia.get(provider).overview(storeId, { days: normalizedDays(days) });
  }

  paidMediaList(
    storeId: string,
    provider: PaidMediaProvider,
    level: PaidMediaLevel,
    input: { days?: number; page?: number; limit?: number } = {},
  ) {
    return this.paidMedia.get(provider).list(storeId, level, {
      days: normalizedDays(input.days),
      page: input.page,
      limit: input.limit,
    });
  }

  paidMediaDetail(
    storeId: string,
    provider: PaidMediaProvider,
    level: PaidMediaLevel,
    entityId: string,
    days = 30,
  ) {
    return this.paidMedia.get(provider).detail(storeId, level, entityId, {
      days: normalizedDays(days),
    });
  }

  adExposureList(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.adExposure.list(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  adExposureDetail(storeId: string, adId: string, days = 30) {
    return this.adExposure.detail(storeId, adId, { days: normalizedDays(days) });
  }

  storefrontOverview(storeId: string, days = 30) {
    return this.storefrontOverviewReads.read(storeId, { days: normalizedDays(days) });
  }

  storefrontProducts(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.storefront.products(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  storefrontCollections(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.storefront.collections(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  storefrontLandingPages(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.storefront.landingPages(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  storefrontHealth(storeId: string) {
    return this.pixelHealth.read(storeId);
  }

  attributionSources(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.attribution.sources(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  attributionMetaAds(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.attribution.metaAds(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  attributionPaths(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.attribution.paths(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  attributionMappings(
    storeId: string,
    targetType: 'PRODUCT' | 'COLLECTION',
    input: { days?: number; page?: number; limit?: number } = {},
  ) {
    return this.attribution.mappingEvidence(
      storeId,
      targetType,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  productAdsList(storeId: string, input: { days?: number; page?: number; limit?: number } = {}) {
    return this.productAds.list(
      storeId,
      listQuery(normalizedDays(input.days), input.page ?? 1, input.limit ?? 50),
    );
  }

  productAdsDetail(storeId: string, productId: string, days = 30) {
    return this.productAds.detail(storeId, productId, { days: normalizedDays(days) });
  }

  intelligenceSettings(storeId: string) {
    return this.intelligenceSettingsReads.getSettings(storeId);
  }

  inventoryPlanningSettings(storeId: string) {
    return this.inventoryPlanningReads.get(storeId);
  }

  async recommendations(storeId: string, options: { fresh?: boolean } = {}) {
    const [snapshot, plan] = await Promise.all([
      this.intelligence.read(storeId, options),
      this.billing.requireActive(storeId),
    ]);
    const recommendationLimit = Math.max(
      1,
      Number(plan.entitlements.recommendationLimit ?? 10),
    );
    const recommendations = await recommendationLifecycleService.attach(
      storeId,
      snapshot.recommendations.slice(0, recommendationLimit),
    );
    return {
      ...snapshot,
      recommendations,
      entitlement: { recommendationLimit },
    };
  }

  report(storeId: string, input: { days?: number; fresh?: boolean } = {}) {
    return this.reports.read(
      storeId,
      { days: normalizedDays(input.days) },
      new Date(),
      { fresh: input.fresh ?? false },
    );
  }

  async search(
    storeId: string,
    input: {
      query: string;
      entityTypes?: AdvisorEntityType[];
      days?: number;
      limit?: number;
      paidMediaProviders?: PaidMediaProvider[];
    },
  ) {
    const query = input.query.trim().toLocaleLowerCase();
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
    const days = normalizedDays(input.days);
    const searchableProviders = new Set<PaidMediaProvider>(
      input.paidMediaProviders ?? ['META', 'TIKTOK'],
    );
    const requested = new Set<AdvisorEntityType>(
      input.entityTypes?.length
        ? input.entityTypes
        : [
            'PRODUCT',
            'COLLECTION',
            'CAMPAIGN',
            'GROUP',
            'AD',
            'CREATIVE',
            'LANDING_PAGE',
            'ATTRIBUTION_SOURCE',
            'RECOMMENDATION',
          ],
    );
    const reads: Array<Promise<AdvisorSearchResult[]>> = [];

    if (requested.has('PRODUCT')) {
      reads.push(
        this.products(storeId, { days, page: 1, limit: 100 }).then((value) =>
          items(value).map((row) => resultFromRow('PRODUCT', row, 'SHOPIFY')),
        ),
      );
    }
    if (requested.has('COLLECTION')) {
      reads.push(
        this.collections(storeId, { days, page: 1, limit: 100 }).then((value) =>
          items(value).map((row) => resultFromRow('COLLECTION', row, 'SHOPIFY')),
        ),
      );
    }
    for (const [type, level] of [
      ['CAMPAIGN', 'CAMPAIGN'],
      ['GROUP', 'GROUP'],
      ['AD', 'AD'],
      ['CREATIVE', 'CREATIVE'],
    ] as const) {
      if (!requested.has(type)) continue;
      if (searchableProviders.has('META')) {
        reads.push(
          this.paidMediaList(storeId, 'META', level, { days, page: 1, limit: 100 }).then((value) =>
            items(value).map((row) => resultFromRow(type, row, 'META')),
          ),
        );
      }
      if (level !== 'CREATIVE' && searchableProviders.has('TIKTOK')) {
        reads.push(
          this.paidMediaList(storeId, 'TIKTOK', level, { days, page: 1, limit: 100 }).then((value) =>
            items(value).map((row) => resultFromRow(type, row, 'TIKTOK')),
          ),
        );
      }
    }
    if (requested.has('LANDING_PAGE')) {
      reads.push(
        this.storefrontLandingPages(storeId, { days, page: 1, limit: 100 }).then((value) =>
          items(value).map((row) => resultFromRow('LANDING_PAGE', row, 'PIXEL')),
        ),
      );
    }
    if (requested.has('ATTRIBUTION_SOURCE')) {
      reads.push(
        this.attributionSources(storeId, { days, page: 1, limit: 100 }).then((value) =>
          items(value).map((row) => resultFromRow('ATTRIBUTION_SOURCE', row, 'PIXEL')),
        ),
      );
    }
    if (requested.has('RECOMMENDATION')) {
      reads.push(
        this.recommendations(storeId).then((value) =>
          value.recommendations.map((row) => resultFromRow('RECOMMENDATION', row, 'STRIDE')),
        ),
      );
    }

    const candidates = (await Promise.all(reads)).flat();
    const matches = candidates.filter((candidate) => {
      if (!query) return true;
      const haystack = `${candidate.name} ${candidate.id ?? ''} ${candidate.externalId ?? ''} ${searchableEvidence(candidate.evidence)}`.toLocaleLowerCase();
      return haystack.includes(query);
    });

    return {
      query: input.query,
      searchedEntityTypes: [...requested],
      paidMediaProvidersSearched: [...searchableProviders],
      totalMatches: matches.length,
      truncated: matches.length > limit,
      items: matches.slice(0, limit),
      privacy: 'Business entities and aggregate evidence only; customer PII is not part of advisor search.',
    };
  }
}

export const advisorReadService = new AdvisorReadService();
