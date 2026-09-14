import {
  campaignEfficiencyRule,
  creativeFatigueRule,
  inventorySpendConflictRule,
  marginTrapRule,
  paidCommerceMismatchRule,
  sharedExposureInventoryRule,
  underexposedProductRule,
} from '../src/modules/intelligence/intelligence.rules.js';
import { recommendationDecision } from '../src/modules/intelligence/recommendation-decision.js';
import type {
  CampaignEvidence,
  CreativeEvidence,
  HistoricalMetrics,
  ProductEvidence,
  RecommendationDraft,
  SharedExposureEvidence,
} from '../src/modules/intelligence/intelligence.types.js';

const start = new Date('2026-09-01T00:00:00.000Z');
const end = new Date('2026-09-07T23:59:59.999Z');
const productWindow = { start: new Date('2026-08-11T00:00:00.000Z'), end };

function metrics(overrides: Partial<HistoricalMetrics> = {}): HistoricalMetrics {
  return {
    spend: 1_000,
    impressions: 20_000,
    reach: 12_000,
    clicks: 600,
    purchases: 40,
    purchaseValue: 4_000,
    roas: 4,
    cpa: 25,
    ctr: 0.03,
    cpc: 1.6667,
    cpm: 50,
    frequency: 1.7,
    ...overrides,
  };
}

function campaign(overrides: Partial<CampaignEvidence> = {}): CampaignEvidence {
  return {
    entityId: 'scenario-campaign-local',
    externalEntityId: 'scenario-campaign-meta',
    name: 'SCN Campaign',
    currency: 'GBP',
    spendShare: 0.42,
    start,
    end,
    current: metrics(),
    comparison: metrics(),
    ...overrides,
  };
}

function creative(overrides: Partial<CreativeEvidence> = {}): CreativeEvidence {
  return {
    entityId: 'scenario-creative-local',
    externalEntityId: 'scenario-creative-meta',
    name: 'SCN Creative',
    currency: 'GBP',
    spendShare: 0.24,
    start,
    end,
    current: metrics(),
    comparison: metrics(),
    ...overrides,
  };
}

function product(overrides: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    entityId: 'scenario-product-local',
    externalEntityId: 'gid://shopify/Product/SCENARIO',
    name: 'SCN Product',
    currency: 'GBP',
    revenue: 25_000,
    netRevenue: 25_000,
    units: 100,
    revenueShare: 0.25,
    mappedMetaSpend: 1_000,
    mappedImpressions: 20_000,
    mappedSpendShare: 0.1,
    mappedProviderValue: 3_200,
    providerRoas: 3.2,
    mappingConfidence: 0.95,
    mappingCoverage: 0.9,
    contributionBeforeAds: 12_000,
    contributionAfterAds: 11_000,
    costCoverage: 1,
    inventoryTrusted: false,
    stockAvailable: null,
    recentUnitsPerDay: null,
    daysCover: null,
    ...overrides,
  };
}

function shared(overrides: Partial<SharedExposureEvidence> = {}): SharedExposureEvidence {
  return {
    entityId: 'scenario-ad-local',
    externalEntityId: 'scenario-ad-meta',
    name: 'SCN Shared Product Ad',
    currency: 'GBP',
    scope: 'MULTI_PRODUCT',
    scopeConfidence: 0.95,
    merchantConfirmed: false,
    sharedAdSpend: 5_000,
    impressions: 25_000,
    inventoryTrusted: true,
    products: [
      {
        entityId: 'scenario-low-stock',
        externalEntityId: 'gid://shopify/Product/LOW_STOCK',
        name: 'SCN Low Stock Product',
        stockAvailable: 12,
        recentUnitsPerDay: 3,
        daysCover: 4,
      },
      {
        entityId: 'scenario-healthy-stock',
        externalEntityId: 'gid://shopify/Product/HEALTHY_STOCK',
        name: 'SCN Healthy Stock Product',
        stockAvailable: 200,
        recentUnitsPerDay: 4,
        daysCover: 50,
      },
    ],
    collectionMembershipTruncated: false,
    collections: [],
    ...overrides,
  };
}

type Scenario = {
  name: string;
  expectedRuleId: string;
  evaluate: () => RecommendationDraft | null;
};

const scenarios: Scenario[] = [
  {
    name: 'Campaign efficiency deterioration',
    expectedRuleId: 'campaign_efficiency_deterioration',
    evaluate: () =>
      campaignEfficiencyRule(
        campaign({ current: metrics({ spend: 1_400, roas: 2.28, cpa: 56, ctr: 0.022, cpm: 70 }) }),
      ),
  },
  {
    name: 'Creative fatigue symptoms',
    expectedRuleId: 'creative_fatigue_symptoms',
    evaluate: () =>
      creativeFatigueRule(
        creative({
          comparison: metrics({ frequency: 1.5, ctr: 0.03, cpa: 25, roas: 4 }),
          current: metrics({ frequency: 2.3, ctr: 0.02, cpa: 36, roas: 2.9 }),
        }),
      ),
  },
  {
    name: 'Underexposed commerce winner',
    expectedRuleId: 'underexposed_commerce_winner',
    evaluate: () => underexposedProductRule(product({ revenueShare: 0.35, mappedSpendShare: 0.08 }), productWindow),
  },
  {
    name: 'Paid-commerce exposure mismatch',
    expectedRuleId: 'paid_commerce_exposure_mismatch',
    evaluate: () =>
      paidCommerceMismatchRule(
        product({ revenue: 5_000, netRevenue: 5_000, units: 15, revenueShare: 0.05, mappedMetaSpend: 3_000, mappedSpendShare: 0.3, mappedImpressions: 25_000 }),
        productWindow,
      ),
  },
  {
    name: 'Provider ROAS margin trap',
    expectedRuleId: 'provider_roas_margin_trap',
    evaluate: () =>
      marginTrapRule(
        product({ revenue: 15_000, netRevenue: 15_000, revenueShare: 0.15, mappedMetaSpend: 6_000, mappedSpendShare: 0.12, mappedProviderValue: 19_200, providerRoas: 3.2, contributionBeforeAds: 3_000, contributionAfterAds: -3_000, costCoverage: 1 }),
        productWindow,
      ),
  },
  {
    name: 'Direct inventory spend conflict',
    expectedRuleId: 'inventory_spend_conflict',
    evaluate: () =>
      inventorySpendConflictRule(
        product({ inventoryTrusted: true, stockAvailable: 20, recentUnitsPerDay: 5, daysCover: 4, mappedMetaSpend: 1_500 }),
        productWindow,
      ),
  },
  {
    name: 'Shared multi-product inventory conflict',
    expectedRuleId: 'shared_exposure_inventory_conflict',
    evaluate: () => sharedExposureInventoryRule(shared(), productWindow),
  },
  {
    name: '2026 benchmark-informed Meta deterioration',
    expectedRuleId: 'campaign_efficiency_deterioration',
    evaluate: () =>
      campaignEfficiencyRule(
        campaign({
          spendShare: 0.55,
          comparison: metrics({ spend: 3_899, impressions: 258_898, clicks: 6_187, purchases: 100, purchaseValue: 7_330, roas: 1.88, cpa: 38.99, ctr: 0.0239, cpc: 0.63, cpm: 15.06, frequency: 1.8 }),
          current: metrics({ spend: 4_900, impressions: 280_000, clicks: 5_040, purchases: 90, purchaseValue: 6_300, roas: 1.2857, cpa: 54.44, ctr: 0.018, cpc: 0.9722, cpm: 17.5, frequency: 2.15 }),
        }),
      ),
  },
];

const asJson = process.argv.includes('--json');
const results = scenarios.map((scenario) => {
  const recommendation = scenario.evaluate();
  if (!recommendation) {
    return { name: scenario.name, ok: false, error: 'No recommendation emitted' };
  }
  const decision = recommendationDecision(recommendation);
  return {
    name: scenario.name,
    ok: recommendation.ruleId === scenario.expectedRuleId,
    ruleId: recommendation.ruleId,
    category: recommendation.category,
    severity: recommendation.severity,
    action: decision.decisionAction,
    confidence: decision.decisionConfidence,
    message: decision.decisionMessage,
    priority: Number((recommendation.impactScore * recommendation.confidenceScore * recommendation.urgencyScore).toFixed(4)),
    limitations: recommendation.limitations.map((limitation) => limitation.code),
  };
});

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\nStride deterministic intelligence scenario lab\n');
  for (const result of results) {
    if (!result.ok) {
      console.log(`✗ ${result.name}: ${result.error ?? 'unexpected rule'}`);
      continue;
    }
    console.log(`✓ ${result.name}`);
    console.log(`  ${result.ruleId} → ${result.action} · ${result.severity} · confidence ${result.confidence}`);
    console.log(`  ${result.message}`);
    if (result.limitations?.length) console.log(`  limitations: ${result.limitations.join(', ')}`);
  }
  console.log(`\n${results.filter((result) => result.ok).length}/${results.length} scenarios emitted the expected rule.\n`);
}

if (results.some((result) => !result.ok)) process.exitCode = 1;
