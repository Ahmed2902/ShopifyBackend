import type {
  UnifiedAdvertisingListQuery,
  UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';
import {
  unifiedAdvertisingIntelligenceService,
  type UnifiedAdvertisingIntelligenceService,
} from '../advertising/unified-advertising-intelligence.service.js';
import {
  unifiedPaidEntityService,
  type UnifiedPaidEntityService,
} from '../advertising/unified-paid-entity.service.js';
import {
  unifiedProductAdsIntelligenceService,
  type UnifiedProductAdsIntelligenceService,
} from '../analytics/unified-product-ads-intelligence.service.js';
import {
  intelligenceContextReadRepository,
  type IntelligenceContextReadRepository,
} from './intelligence-context.read.repository.js';
import {
  recommendationLifecycleService,
  type RecommendationLifecycleService,
} from './recommendation-lifecycle.service.js';
import type {
  RecommendationDraft,
  RecommendationEvidenceQuality,
  RecommendationSeverity,
} from './intelligence.types.js';

const RULE_VERSION = '1';
const MAX_ENTITY_EVALUATION = 100;
const MAX_PRODUCT_EVALUATION = 100;

function date(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function evidenceScore(quality: RecommendationEvidenceQuality) {
  // Compatibility with the existing ranking contract. These are discrete rubric weights, not
  // probabilities: LOW=0.35, MEDIUM=0.65, HIGH=0.90.
  if (quality === 'HIGH') return 0.9;
  if (quality === 'MEDIUM') return 0.65;
  return 0.35;
}

function severityScore(severity: RecommendationSeverity) {
  if (severity === 'CRITICAL') return 1;
  if (severity === 'HIGH') return 0.85;
  if (severity === 'MEDIUM') return 0.6;
  return 0.35;
}

function priority(recommendation: RecommendationDraft) {
  return (
    recommendation.impactScore * 0.45 +
    recommendation.confidenceScore * 0.35 +
    recommendation.urgencyScore * 0.2
  );
}

function entitySeverity(value: 'INFO' | 'WARNING' | 'HIGH'): RecommendationSeverity {
  if (value === 'HIGH') return 'HIGH';
  if (value === 'WARNING') return 'MEDIUM';
  return 'LOW';
}

function entityQuality(value: 'LOW' | 'MEDIUM' | 'HIGH'): RecommendationEvidenceQuality {
  return value;
}

function qualityDraft(input: {
  item: {
    code: string;
    status: 'HEALTHY' | 'WARNING' | 'BLOCKED';
    surface: string;
    message: string;
    provider?: string;
    accountId?: string;
    metrics?: Record<string, unknown>;
  };
  start: Date;
  end: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): RecommendationDraft | null {
  if (input.item.status === 'HEALTHY' || input.item.code === 'UNAVAILABLE_REACH') return null;
  const severity: RecommendationSeverity =
    input.item.status === 'BLOCKED' ? 'HIGH' : 'MEDIUM';
  const evidenceQuality: RecommendationEvidenceQuality =
    input.item.status === 'BLOCKED' ? 'LOW' : 'MEDIUM';
  return {
    ruleId: `unified_data_quality_${input.item.code.toLowerCase()}`,
    ruleVersion: RULE_VERSION,
    category: 'DATA_QUALITY',
    severity,
    entityType: input.item.accountId ? 'AD_ACCOUNT' : 'STORE',
    entityId: input.item.accountId ?? null,
    externalEntityId: null,
    title: input.item.code.replaceAll('_', ' '),
    summary: input.item.message,
    suggestedAction: 'Restore or verify the missing evidence before acting on affected metrics.',
    impactScore: severityScore(severity),
    confidenceScore: evidenceScore(evidenceQuality),
    urgencyScore: input.item.status === 'BLOCKED' ? 0.9 : 0.55,
    evidenceQuality,
    attributionPrecision: 'UNKNOWN',
    limitations: [
      {
        code: input.item.code,
        message: input.item.message,
      },
    ],
    observationStart: input.start,
    observationEnd: input.end,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    evidence: {
      surface: input.item.surface,
      provider: input.item.provider ?? null,
      metrics: input.item.metrics ?? null,
    },
  };
}

function entityDraft(input: {
  kind: 'CAMPAIGN' | 'GROUP' | 'AD';
  item: {
    entity: {
      id: string;
      providerEntityId: string;
      name: string;
      account: { id: string; provider: string };
    };
    current: Record<string, unknown>;
    comparison: Record<string, unknown>;
    intelligence: {
      confidence: 'LOW' | 'MEDIUM' | 'HIGH';
      signals: Array<{
        code: string;
        severity: 'INFO' | 'WARNING' | 'HIGH';
        conclusion: string;
        evidence: Record<string, number | null>;
      }>;
      limitations: string[];
    };
  };
  signal: {
    code: string;
    severity: 'INFO' | 'WARNING' | 'HIGH';
    conclusion: string;
    evidence: Record<string, number | null>;
  };
  start: Date;
  end: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): RecommendationDraft {
  const severity = entitySeverity(input.signal.severity);
  const evidenceQuality = entityQuality(input.item.intelligence.confidence);
  const category = input.signal.code.includes('DELIVERY')
    ? 'PAID_MEDIA_DELIVERY'
    : 'PAID_MEDIA_EFFICIENCY';
  return {
    ruleId: `unified_${input.kind.toLowerCase()}_${input.signal.code.toLowerCase()}`,
    ruleVersion: RULE_VERSION,
    category,
    severity,
    entityType: input.kind,
    entityId: input.item.entity.id,
    externalEntityId: input.item.entity.providerEntityId,
    entityName: input.item.entity.name,
    title: input.signal.code.replaceAll('_', ' '),
    summary: input.signal.conclusion,
    suggestedAction:
      severity === 'HIGH'
        ? 'Hold further scaling and investigate the deterioration before changing budget.'
        : 'Review this entity and its comparison-period evidence before changing budget.',
    impactScore: severityScore(severity),
    confidenceScore: evidenceScore(evidenceQuality),
    urgencyScore: severity === 'HIGH' ? 0.85 : severity === 'MEDIUM' ? 0.6 : 0.35,
    evidenceQuality,
    attributionPrecision: 'PROVIDER_REPORTED',
    limitations: input.item.intelligence.limitations.map((code) => ({
      code,
      message: code.replaceAll('_', ' '),
    })),
    observationStart: input.start,
    observationEnd: input.end,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    evidence: {
      provider: input.item.entity.account.provider,
      accountId: input.item.entity.account.id,
      current: input.item.current,
      comparison: input.item.comparison,
      signal: input.signal.evidence,
    },
  };
}

function productDraft(input: {
  item: {
    product: { id: string; shopifyProductId: string; title: string };
    current: {
      commerce: Record<string, unknown> & {
        evidenceAvailable?: boolean;
        netProductRevenue?: number | null;
        contributionBeforeAds?: number | null;
      };
      advertising: { spend: number | null; byProvider: unknown[] };
      storefront: {
        available: boolean;
        metrics: null | {
          productViewSessions: number;
          viewToCartRate: number | null;
          checkoutAbandonmentRate: number | null;
        };
      };
      inventory: { state: string; available: number | null; daysCover: number | null };
      intelligence: {
        contributionAfterAds: number | null;
        inefficientPaidDemand: boolean | null;
        profitableDemand: boolean | null;
        confidence: 'LOW' | 'MEDIUM' | 'HIGH';
        limitations: string[];
      };
    };
    mapping: { confidence: number; merchantConfirmed: boolean; limitations: string[] };
  };
  start: Date;
  end: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): RecommendationDraft[] {
  const drafts: RecommendationDraft[] = [];
  const spend = input.item.current.advertising.spend;
  const authoritativeCommerce = input.item.current.commerce.evidenceAvailable === true;
  const confidence = input.item.current.intelligence.confidence;
  const evidenceQuality: RecommendationEvidenceQuality = confidence;
  const common = {
    ruleVersion: RULE_VERSION,
    entityType: 'PRODUCT' as const,
    entityId: input.item.product.id,
    externalEntityId: input.item.product.shopifyProductId,
    entityName: input.item.product.title,
    confidenceScore: evidenceScore(evidenceQuality),
    evidenceQuality,
    attributionPrecision: 'EXACT_PRODUCT' as const,
    observationStart: input.start,
    observationEnd: input.end,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    limitations: input.item.current.intelligence.limitations.map((code) => ({
      code,
      message: code.replaceAll('_', ' '),
    })),
  };

  if (
    spend !== null &&
    spend > 0 &&
    ['SOLD_OUT', 'STOCKOUT_RISK', 'LOW_STOCK'].includes(input.item.current.inventory.state)
  ) {
    drafts.push({
      ...common,
      ruleId: 'unified_inventory_paid_spend_conflict',
      category: 'INVENTORY_SPEND_CONFLICT',
      severity: input.item.current.inventory.state === 'SOLD_OUT' ? 'CRITICAL' : 'HIGH',
      title: 'Paid demand conflicts with inventory',
      summary: `This product is receiving mapped paid spend while inventory state is ${input.item.current.inventory.state}.`,
      suggestedAction: 'Hold aggressive scaling until inventory risk is resolved.',
      impactScore: input.item.current.inventory.state === 'SOLD_OUT' ? 1 : 0.9,
      urgencyScore: input.item.current.inventory.state === 'SOLD_OUT' ? 1 : 0.9,
      evidence: {
        mappedPaidSpend: spend,
        inventory: input.item.current.inventory,
        byProvider: input.item.current.advertising.byProvider,
      },
    });
  }

  if (
    authoritativeCommerce &&
    input.item.current.inventory.state === 'OVERSTOCK_WEAK_DEMAND'
  ) {
    drafts.push({
      ...common,
      ruleId: 'unified_inventory_overstock_weak_demand',
      category: 'INVENTORY_SPEND_CONFLICT',
      severity: 'MEDIUM',
      title: 'Overstock meets weak observed demand',
      summary: 'Trusted inventory evidence shows elevated stock while current product sales velocity is zero.',
      suggestedAction: 'Review merchandising and demand-generation strategy before committing additional inventory.',
      impactScore: 0.65,
      urgencyScore: 0.5,
      attributionPrecision: 'SHOPIFY_COMMERCE',
      evidence: {
        inventory: input.item.current.inventory,
        commerce: input.item.current.commerce,
        mappedPaidSpend: spend,
      },
    });
  }

  if (
    authoritativeCommerce &&
    input.item.current.intelligence.inefficientPaidDemand === true
  ) {
    drafts.push({
      ...common,
      ruleId: 'unified_product_paid_demand_negative_contribution',
      category: 'PRODUCT_ADS_ECONOMICS',
      severity: 'HIGH',
      title: 'Mapped paid demand exceeds product contribution',
      summary: 'Shopify contribution after exact mapped paid spend is negative.',
      suggestedAction: 'Reduce or investigate mapped paid demand before scaling this product.',
      impactScore: 0.9,
      urgencyScore: 0.8,
      evidence: {
        contributionAfterAds: input.item.current.intelligence.contributionAfterAds,
        mappedPaidSpend: spend,
        commerce: input.item.current.commerce,
      },
    });
  }

  if (
    authoritativeCommerce &&
    spend === 0 &&
    (input.item.current.commerce.netProductRevenue ?? 0) > 0 &&
    (input.item.current.commerce.contributionBeforeAds ?? 0) > 0 &&
    input.item.current.inventory.state === 'HEALTHY'
  ) {
    drafts.push({
      ...common,
      ruleId: 'unified_profitable_product_low_paid_support',
      category: 'PRODUCT_ADS_ECONOMICS',
      severity: 'LOW',
      title: 'Profitable product has low mapped paid support',
      summary: 'Shopify contribution is positive, trusted inventory is healthy, and exact mapped paid-media evidence reports zero spend.',
      suggestedAction: 'Review whether limited paid support is intentional; validate demand and constraints before any budget increase.',
      impactScore: 0.45,
      urgencyScore: 0.3,
      evidence: {
        mappedPaidSpend: spend,
        commerce: input.item.current.commerce,
        inventory: input.item.current.inventory,
      },
    });
  }

  const pixel = input.item.current.storefront;
  if (
    spend !== null &&
    spend > 0 &&
    pixel.available &&
    pixel.metrics &&
    pixel.metrics.productViewSessions >= 20 &&
    pixel.metrics.viewToCartRate !== null &&
    pixel.metrics.viewToCartRate < 0.1
  ) {
    drafts.push({
      ...common,
      ruleId: 'unified_paid_product_weak_view_to_cart',
      category: 'PRODUCT_CONVERSION',
      severity: 'MEDIUM',
      title: 'Paid product demand meets weak on-site conversion',
      summary:
        'The product has mapped paid demand and observed storefront views but a low view-to-cart rate; this is correlation evidence, not proof that advertising caused the weakness.',
      suggestedAction: 'Review product-page offer and landing experience before increasing paid support.',
      impactScore: 0.65,
      urgencyScore: 0.55,
      attributionPrecision: 'FIRST_PARTY_OBSERVED',
      evidence: {
        mappedPaidSpend: spend,
        storefront: pixel.metrics,
      },
      limitations: [
        ...common.limitations,
        {
          code: 'CORRELATION_NOT_CAUSATION',
          message: 'Stride Pixel observations do not establish that advertising caused the funnel weakness.',
        },
      ],
    });
  }

  return drafts;
}

export class UnifiedDecisionService {
  constructor(
    private readonly advertising: UnifiedAdvertisingIntelligenceService =
      unifiedAdvertisingIntelligenceService,
    private readonly entities: UnifiedPaidEntityService = unifiedPaidEntityService,
    private readonly products: UnifiedProductAdsIntelligenceService =
      unifiedProductAdsIntelligenceService,
    private readonly lifecycle: RecommendationLifecycleService = recommendationLifecycleService,
    private readonly context: IntelligenceContextReadRepository = intelligenceContextReadRepository,
  ) {}

  async read(storeId: string, query: UnifiedAdvertisingRangeQuery, now = new Date()) {
    const listQuery: UnifiedAdvertisingListQuery = {
      ...query,
      page: 1,
      limit: MAX_ENTITY_EVALUATION,
    };
    const productQuery: UnifiedAdvertisingListQuery = {
      ...query,
      page: 1,
      limit: MAX_PRODUCT_EVALUATION,
    };
    const [overview, campaigns, groups, ads, products, context] = await Promise.all([
      this.advertising.read(storeId, query, now),
      this.entities.list(storeId, 'CAMPAIGN', listQuery, now),
      this.entities.list(storeId, 'GROUP', listQuery, now),
      this.entities.list(storeId, 'AD', listQuery, now),
      this.products.list(storeId, productQuery, now),
      this.context.getContext(storeId),
    ]);

    const commerceHistoryComplete =
      context?.shopifyConnection?.status === 'ACTIVE' &&
      context.successfulOrderHistorySync?.status === 'SUCCEEDED';
    const hasCommerceHistoryBlocker = overview.dataQuality.items.some(
      (item) => item.code === 'INCOMPLETE_COMMERCE_HISTORY',
    );
    const dataQuality =
      commerceHistoryComplete || hasCommerceHistoryBlocker
        ? overview.dataQuality
        : {
            ...overview.dataQuality,
            confidence: 'LOW' as const,
            items: [
              ...overview.dataQuality.items,
              {
                code: 'INCOMPLETE_COMMERCE_HISTORY',
                status: 'BLOCKED' as const,
                surface: 'COMMERCE',
                message:
                  'No completed Shopify order-history sync is available, so historical commerce conclusions may be incomplete.',
              },
            ],
          };

    const start = date(overview.window.current.from);
    const end = date(overview.window.current.to);
    const comparisonStart = date(overview.window.comparison.from);
    const comparisonEnd = date(overview.window.comparison.to);
    const drafts: RecommendationDraft[] = [];

    for (const quality of dataQuality.items) {
      const draft = qualityDraft({
        item: quality,
        start,
        end,
        comparisonStart,
        comparisonEnd,
      });
      if (draft) drafts.push(draft);
    }

    for (const [kind, collection] of [
      ['CAMPAIGN', campaigns] as const,
      ['GROUP', groups] as const,
      ['AD', ads] as const,
    ]) {
      for (const item of collection.items) {
        for (const signal of item.intelligence.signals) {
          if (signal.code === 'LOW_DELIVERY_INSUFFICIENT_EVIDENCE') continue;
          drafts.push(
            entityDraft({
              kind,
              item,
              signal,
              start,
              end,
              comparisonStart,
              comparisonEnd,
            }),
          );
        }
      }
    }

    for (const item of products.items) {
      drafts.push(
        ...productDraft({ item, start, end, comparisonStart, comparisonEnd }),
      );
    }

    const ranked = drafts
      .map((draft) => ({ ...draft, priority: priority(draft) }))
      .sort((left, right) => right.priority - left.priority)
      .slice(0, 100);
    const decorated = await this.lifecycle.attach(storeId, ranked);

    return {
      schemaVersion: '2.0',
      generatedAt: now,
      truthModel: overview.truthModel,
      filters: overview.filters,
      window: overview.window,
      recommendations: decorated,
      confidenceModel: {
        type: 'DETERMINISTIC_ENUM',
        levels: ['LOW', 'MEDIUM', 'HIGH'],
        criteria: {
          LOW: 'Current evidence missing/too small, blocked data quality, incomplete mapping or unavailable required economics.',
          MEDIUM:
            'Current evidence is usable but comparison, freshness, sample size, mapping or another evidence-quality dimension is limited.',
          HIGH: 'Current and comparison evidence are available with sufficient sample and no blocking limitation.',
        },
        rankingCompatibilityWeights: { LOW: 0.35, MEDIUM: 0.65, HIGH: 0.9 },
        weightsAreProbabilities: false,
      },
      dataQuality,
      evaluationBounds: {
        campaigns: MAX_ENTITY_EVALUATION,
        groups: MAX_ENTITY_EVALUATION,
        ads: MAX_ENTITY_EVALUATION,
        products: MAX_PRODUCT_EVALUATION,
        truncated:
          campaigns.pagination.total > MAX_ENTITY_EVALUATION ||
          groups.pagination.total > MAX_ENTITY_EVALUATION ||
          ads.pagination.total > MAX_ENTITY_EVALUATION ||
          products.pagination.total > MAX_PRODUCT_EVALUATION,
      },
      limitations: [
        'Provider attribution remains provider-reported evidence and never replaces Shopify commerce truth.',
        'Pixel-based recommendations describe observed correlation, not causal proof.',
        'Shared, ambiguous and unsupported PMax product spend is not allocated to products.',
        'Decision evaluation is deliberately bounded; the response reports when entity coverage is truncated.',
      ],
    };
  }
}

export const unifiedDecisionService = new UnifiedDecisionService();