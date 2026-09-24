import {
  unifiedAdvertisingIntelligenceService,
  type UnifiedAdvertisingIntelligenceService,
} from '../advertising/unified-advertising-intelligence.service.js';
import type {
  UnifiedAdvertisingListQuery,
  UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';
import {
  unifiedPaidEntityService,
  type UnifiedPaidEntityService,
} from '../advertising/unified-paid-entity.service.js';
import {
  unifiedProductAdsIntelligenceService,
  type UnifiedProductAdsIntelligenceService,
} from '../analytics/unified-product-ads-intelligence.service.js';
import {
  pixelHealthService,
  type PixelHealthService,
} from '../pixel/pixel-health.service.js';
import {
  intelligenceContextReadRepository,
  type IntelligenceContextReadRepository,
} from './intelligence-context.read.repository.js';
import type { UnifiedDataQualityItem } from '../advertising/unified-advertising.service.js';

const MAX_SAMPLE_AUDIT = 100;
const PIXEL_STALE_HOURS = 48;
const STATIC_CAPABILITY_CODES = new Set([
  'UNAVAILABLE_REACH',
  'PMAX_PRODUCT_ALLOCATION_LIMITATION',
]);

function ageHours(now: Date, value: Date | null): number | null {
  return value ? Math.max(0, (now.getTime() - value.getTime()) / 3_600_000) : null;
}

function confidence(items: UnifiedDataQualityItem[]) {
  const relevant = items.filter((item) => !STATIC_CAPABILITY_CODES.has(item.code));
  if (relevant.some((item) => item.status === 'BLOCKED')) return 'LOW' as const;
  if (relevant.some((item) => item.status === 'WARNING')) return 'MEDIUM' as const;
  return 'HIGH' as const;
}

function lowSampleCount(value: {
  items: Array<{
    intelligence: {
      confidence: 'LOW' | 'MEDIUM' | 'HIGH';
      signals: Array<{ code: string }>;
      limitations: string[];
    };
  }>;
}) {
  return value.items.filter(
    (item) =>
      item.intelligence.confidence === 'LOW' ||
      item.intelligence.signals.some(
        (signal) => signal.code === 'LOW_DELIVERY_INSUFFICIENT_EVIDENCE',
      ) ||
      item.intelligence.limitations.includes('COMPARISON_DELIVERY_INSUFFICIENT'),
  ).length;
}

/**
 * Cross-source quality boundary used by HTTP and advisor consumers.
 *
 * This service composes existing truth-owning reads. It does not recalculate provider or Shopify
 * facts. Expensive entity inspection is deliberately bounded and reports truncation.
 */
export class UnifiedDataQualityService {
  constructor(
    private readonly advertising: UnifiedAdvertisingIntelligenceService =
      unifiedAdvertisingIntelligenceService,
    private readonly productAds: UnifiedProductAdsIntelligenceService =
      unifiedProductAdsIntelligenceService,
    private readonly paidEntities: UnifiedPaidEntityService = unifiedPaidEntityService,
    private readonly pixel: PixelHealthService = pixelHealthService,
    private readonly context: IntelligenceContextReadRepository = intelligenceContextReadRepository,
  ) {}

  async read(storeId: string, query: UnifiedAdvertisingRangeQuery, now = new Date()) {
    const listQuery: UnifiedAdvertisingListQuery = {
      ...query,
      page: 1,
      limit: MAX_SAMPLE_AUDIT,
    };
    const [overview, products, campaigns, groups, ads, pixel, context] = await Promise.all([
      this.advertising.read(storeId, query, now),
      this.productAds.list(storeId, listQuery, now),
      this.paidEntities.list(storeId, 'CAMPAIGN', listQuery, now),
      this.paidEntities.list(storeId, 'GROUP', listQuery, now),
      this.paidEntities.list(storeId, 'AD', listQuery, now),
      this.pixel.read(storeId),
      this.context.getContext(storeId),
    ]);

    const items: UnifiedDataQualityItem[] = [...overview.dataQuality.items];

    if (!context?.successfulOrderHistorySync) {
      items.push({
        code: 'INCOMPLETE_COMMERCE_HISTORY',
        status: 'BLOCKED',
        surface: 'COMMERCE',
        message:
          'No completed Shopify order-history sync is available, so historical commerce conclusions may be incomplete.',
      });
    }

    if (pixel.installation.status !== 'ACTIVE') {
      items.push({
        code: 'PIXEL_UNAVAILABLE',
        status: pixel.installation.status === 'PROVISIONING' ? 'WARNING' : 'BLOCKED',
        surface: 'STOREFRONT',
        message: `Stride Pixel is ${pixel.installation.status}; storefront evidence is unavailable or incomplete.`,
      });
    } else {
      const pixelAgeHours = ageHours(now, pixel.installation.lastEventAt);
      if (pixelAgeHours !== null && pixelAgeHours > PIXEL_STALE_HOURS) {
        items.push({
          code: 'PIXEL_STALE',
          status: 'WARNING',
          surface: 'STOREFRONT',
          message: 'Stride Pixel has not observed an event recently; storefront evidence may be stale.',
          metrics: { ageHours: pixelAgeHours, thresholdHours: PIXEL_STALE_HOURS },
        });
      }
      if (pixel.behaviorRollup.lastError) {
        items.push({
          code: 'PIXEL_BEHAVIOR_ROLLUP_FAILED',
          status: 'BLOCKED',
          surface: 'STOREFRONT',
          message: 'Stride Pixel behavior rollup reports an error.',
        });
      }
      if (pixel.attributionRollup.lastError) {
        items.push({
          code: 'PIXEL_ATTRIBUTION_ROLLUP_FAILED',
          status: 'BLOCKED',
          surface: 'ATTRIBUTION',
          message: 'Stride Pixel attribution rollup reports an error.',
        });
      }
    }

    const currentAccounting = products.summary.current;
    if ((currentAccounting.ambiguousObservedSpend ?? 0) > 0) {
      items.push({
        code: 'AMBIGUOUS_MAPPING',
        status: 'WARNING',
        surface: 'PRODUCT_ADS',
        message:
          'Current paid spend is attached to ambiguous product mapping evidence and remains unallocated.',
        metrics: { ambiguousObservedSpend: currentAccounting.ambiguousObservedSpend },
      });
    }
    if ((currentAccounting.unmappedSpend ?? 0) > 0) {
      items.push({
        code: 'MAPPING_GAP',
        status: 'WARNING',
        surface: 'PRODUCT_ADS',
        message: 'Current compatible paid spend remains unmapped to an exact Shopify product.',
        metrics: {
          unmappedSpend: currentAccounting.unmappedSpend,
          mappingCoverage: currentAccounting.mappingCoverage,
        },
      });
    }
    if (overview.accounts.some((account) => account.provider === 'GOOGLE_ADS')) {
      items.push({
        code: 'PMAX_PRODUCT_ALLOCATION_LIMITATION',
        status: 'WARNING',
        surface: 'PRODUCT_ADS',
        provider: 'GOOGLE_ADS',
        message:
          'Google Performance Max or Shopping spend without defensible canonical product mapping remains shared or unmapped; Stride does not guess product allocation.',
      });
    }

    const sampleCounts = {
      campaigns: lowSampleCount(campaigns),
      groups: lowSampleCount(groups),
      ads: lowSampleCount(ads),
    };
    if (sampleCounts.campaigns + sampleCounts.groups + sampleCounts.ads > 0) {
      items.push({
        code: 'INSUFFICIENT_SAMPLE',
        status: 'WARNING',
        surface: 'PAID_MEDIA',
        message:
          'One or more evaluated paid-media entities have insufficient delivery/comparison evidence for strong deterioration conclusions.',
        metrics: sampleCounts,
      });
    }

    const truncated =
      campaigns.pagination.total > MAX_SAMPLE_AUDIT ||
      groups.pagination.total > MAX_SAMPLE_AUDIT ||
      ads.pagination.total > MAX_SAMPLE_AUDIT ||
      products.pagination.total > MAX_SAMPLE_AUDIT;
    if (truncated) {
      items.push({
        code: 'QUALITY_AUDIT_BOUNDED',
        status: 'WARNING',
        surface: 'DATA_QUALITY',
        message:
          'Entity-level sample and mapping quality inspection is bounded; the response reports that not every entity was evaluated.',
        metrics: { maxPerEntityType: MAX_SAMPLE_AUDIT },
      });
    }

    return {
      schemaVersion: '2.0',
      filters: overview.filters,
      window: overview.window,
      confidence: confidence(items),
      items,
      evaluationBounds: {
        maxPerEntityType: MAX_SAMPLE_AUDIT,
        truncated,
      },
      capabilities: {
        ...overview.capabilities,
        pixel: {
          available: pixel.installation.status === 'ACTIVE',
          status: pixel.installation.status,
        },
        productAllocation: {
          exactCanonicalMappingsOnly: true,
          sharedOrAmbiguousSpendAllocated: false,
          pmaxUnmappedWhenNoExactEvidence: true,
        },
        providerCreativeEvidence: {
          normalizedVocabulary: true,
          identicalCapabilitiesAcrossProviders: false,
        },
      },
      methodology: {
        confidence:
          'LOW when a relevant blocking limitation exists; MEDIUM for relevant warnings; HIGH when required evidence has no blocking/warning limitation. Static unsupported reach/PMax capability limitations are reported but do not alone reduce confidence.',
        missingEvidence: 'Missing evidence is never treated as zero.',
        attribution:
          'Provider attribution stays provider-reported evidence; Shopify remains commerce truth.',
      },
    };
  }
}

export const unifiedDataQualityService = new UnifiedDataQualityService();
