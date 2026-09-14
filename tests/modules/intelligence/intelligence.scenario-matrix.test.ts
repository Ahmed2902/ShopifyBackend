import { describe, expect, it } from 'vitest';
import {
  campaignEfficiencyRule,
  creativeFatigueRule,
  inventorySpendConflictRule,
  marginTrapRule,
  paidCommerceMismatchRule,
  sharedExposureInventoryRule,
  underexposedProductRule,
} from '../../../src/modules/intelligence/intelligence.rules.js';
import { recommendationDecision } from '../../../src/modules/intelligence/recommendation-decision.js';
import type {
  CampaignEvidence,
  CreativeEvidence,
  HistoricalMetrics,
  ProductEvidence,
  RecommendationDraft,
  SharedExposureEvidence,
} from '../../../src/modules/intelligence/intelligence.types.js';

const start = new Date('2026-09-01T00:00:00.000Z');
const end = new Date('2026-09-07T23:59:59.999Z');
const productWindow = {
  start: new Date('2026-08-11T00:00:00.000Z'),
  end,
};

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
    revenue: 30_000,
    netRevenue: 30_000,
    units: 100,
    revenueShare: 0.3,
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

function expectDecision(
  recommendation: RecommendationDraft | null,
  input: {
    ruleId: string;
    action: string;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    severity?: string;
  },
) {
  expect(recommendation).not.toBeNull();
  expect(recommendation).toMatchObject({
    ruleId: input.ruleId,
    ...(input.severity ? { severity: input.severity } : {}),
  });
  expect(recommendationDecision(recommendation!)).toMatchObject({
    decisionAction: input.action,
    decisionConfidence: input.confidence,
    decisionBasis: 'DETERMINISTIC_RULE',
  });
}

describe('deterministic intelligence scenario matrix', () => {
  describe('positive scenarios - every current V1 recommendation path', () => {
    it('emits REDUCE for a high-severity campaign efficiency deterioration', () => {
      const result = campaignEfficiencyRule(
        campaign({
          current: metrics({
            spend: 1_400,
            impressions: 20_000,
            clicks: 440,
            purchases: 25,
            purchaseValue: 3_200,
            roas: 2.2857,
            cpa: 56,
            ctr: 0.022,
            cpc: 3.1818,
            cpm: 70,
          }),
        }),
      );

      expectDecision(result, {
        ruleId: 'campaign_efficiency_deterioration',
        action: 'REDUCE',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });

    it('emits HOLD for a medium-severity campaign deterioration', () => {
      const result = campaignEfficiencyRule(
        campaign({
          current: metrics({
            spend: 1_200,
            roas: 3.08,
            cpa: 30.5,
            ctr: 0.027,
            cpm: 55,
          }),
        }),
      );

      expectDecision(result, {
        ruleId: 'campaign_efficiency_deterioration',
        action: 'HOLD',
        confidence: 'HIGH',
        severity: 'MEDIUM',
      });
    });

    it('emits TEST for creative fatigue symptoms', () => {
      const result = creativeFatigueRule(
        creative({
          comparison: metrics({ frequency: 1.5, ctr: 0.03, cpa: 25, roas: 4 }),
          current: metrics({ frequency: 2.3, ctr: 0.02, cpa: 36, roas: 2.9 }),
        }),
      );

      expectDecision(result, {
        ruleId: 'creative_fatigue_symptoms',
        action: 'TEST',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });

    it('emits TEST for a strong Shopify product with low mapped paid exposure', () => {
      const result = underexposedProductRule(product(), productWindow);

      expectDecision(result, {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'HIGH',
        severity: 'MEDIUM',
      });
    });

    it('emits a HIGH underexposed-product signal when the relative gap is at least 20 points', () => {
      const result = underexposedProductRule(
        product({ revenueShare: 0.35, mappedSpendShare: 0.08 }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });

    it('emits INVESTIGATE for paid exposure materially above commerce contribution', () => {
      const result = paidCommerceMismatchRule(
        product({
          revenue: 5_000,
          netRevenue: 5_000,
          units: 15,
          revenueShare: 0.05,
          mappedMetaSpend: 3_000,
          mappedSpendShare: 0.3,
          mappedImpressions: 25_000,
        }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'paid_commerce_exposure_mismatch',
        action: 'INVESTIGATE',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });

    it('still emits mismatch when paid support is strong and Shopify observed zero sales', () => {
      const result = paidCommerceMismatchRule(
        product({
          revenue: 0,
          netRevenue: 0,
          units: 0,
          revenueShare: 0,
          mappedMetaSpend: 3_000,
          mappedImpressions: 25_000,
          mappedSpendShare: 0.3,
          mappedProviderValue: 0,
          providerRoas: 0,
          contributionBeforeAds: null,
          contributionAfterAds: null,
          costCoverage: 0,
        }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'paid_commerce_exposure_mismatch',
        action: 'INVESTIGATE',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });

    it('emits REDUCE when provider ROAS looks healthy but contribution after ads is negative', () => {
      const result = marginTrapRule(
        product({
          revenue: 15_000,
          netRevenue: 15_000,
          units: 100,
          revenueShare: 0.15,
          mappedMetaSpend: 6_000,
          mappedSpendShare: 0.12,
          mappedProviderValue: 19_200,
          providerRoas: 3.2,
          contributionBeforeAds: 3_000,
          contributionAfterAds: -3_000,
          costCoverage: 1,
        }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'provider_roas_margin_trap',
        action: 'REDUCE',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });

    it('emits CRITICAL HOLD when trusted inventory has <=5 days cover and paid spend', () => {
      const result = inventorySpendConflictRule(
        product({
          inventoryTrusted: true,
          stockAvailable: 20,
          recentUnitsPerDay: 5,
          daysCover: 4,
          mappedMetaSpend: 1_500,
        }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'inventory_spend_conflict',
        action: 'HOLD',
        confidence: 'MEDIUM',
        severity: 'CRITICAL',
      });
    });

    it('emits HIGH HOLD when trusted stock cover is between 5 and 10 days', () => {
      const result = inventorySpendConflictRule(
        product({
          inventoryTrusted: true,
          stockAvailable: 40,
          recentUnitsPerDay: 5,
          daysCover: 8,
          mappedMetaSpend: 1_500,
        }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'inventory_spend_conflict',
        action: 'HOLD',
        confidence: 'MEDIUM',
        severity: 'HIGH',
      });
    });

    it('emits shared-exposure inventory conflict without fabricating product-level spend allocation', () => {
      const result = sharedExposureInventoryRule(shared(), productWindow);

      expectDecision(result, {
        ruleId: 'shared_exposure_inventory_conflict',
        action: 'HOLD',
        confidence: 'MEDIUM',
        severity: 'CRITICAL',
      });
      expect(result?.limitations).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'SHARED_SPEND_NOT_ALLOCATED' })]),
      );
      expect(result?.evidence).not.toHaveProperty('productSpend');
      expect(result?.evidence).toMatchObject({
        sharedAdSpend: 5_000,
        spendInterpretation: 'AD_LEVEL_SHARED_EXPOSURE_NOT_PRODUCT_LEVEL_ATTRIBUTION',
      });
    });

    it('emits the collection variant with current-membership and truncation limitations', () => {
      const result = sharedExposureInventoryRule(
        shared({
          scope: 'COLLECTION',
          collectionMembershipTruncated: true,
          collections: [
            {
              id: 'collection-local',
              shopifyCollectionId: 'gid://shopify/Collection/123',
              title: 'SCN Summer Drop',
              handle: 'scn-summer-drop',
              productCount: 120,
              evaluatedProductCount: 50,
              membershipTruncated: true,
            },
          ],
        }),
        productWindow,
      );

      expectDecision(result, {
        ruleId: 'shared_exposure_inventory_conflict',
        action: 'HOLD',
        confidence: 'MEDIUM',
        severity: 'CRITICAL',
      });
      expect(result?.attributionPrecision).toBe('COLLECTION');
      expect(result?.limitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SHARED_SPEND_NOT_ALLOCATED' }),
          expect.objectContaining({ code: 'CURRENT_COLLECTION_MEMBERSHIP' }),
          expect.objectContaining({ code: 'COLLECTION_MEMBERSHIP_TRUNCATED' }),
        ]),
      );
    });
  });

  describe('confidence scenarios', () => {
    it('downgrades exact-product recommendations to MEDIUM with partial global mapping coverage', () => {
      const result = underexposedProductRule(product({ mappingCoverage: 0.4 }), productWindow);

      expectDecision(result, {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'MEDIUM',
      });
      expect(result?.limitations).toContainEqual(
        expect.objectContaining({ code: 'MAPPING_COVERAGE_PARTIAL' }),
      );
    });

    it('downgrades exact-product recommendations to LOW when global mapping coverage is below 30%', () => {
      const result = underexposedProductRule(product({ mappingCoverage: 0.2 }), productWindow);

      expectDecision(result, {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'LOW',
      });
      expect(result?.limitations).toContainEqual(
        expect.objectContaining({ code: 'MAPPING_COVERAGE_VERY_LOW' }),
      );
    });

    it('keeps Meta-provider campaign confidence independent of product mapping coverage', () => {
      const result = campaignEfficiencyRule(
        campaign({ current: metrics({ spend: 1_400, roas: 2.2, cpa: 55, ctr: 0.021 }) }),
      );

      expectDecision(result, {
        ruleId: 'campaign_efficiency_deterioration',
        action: 'REDUCE',
        confidence: 'HIGH',
      });
      expect(result?.attributionPrecision).toBe('META_PROVIDER');
    });
  });

  describe('hard suppression and boundary scenarios', () => {
    it.each([
      ['current impressions below 1,000', campaign({ current: metrics({ impressions: 999, spend: 1_400, roas: 2 }) })],
      ['comparison impressions below 1,000', campaign({ comparison: metrics({ impressions: 999 }), current: metrics({ spend: 1_400, roas: 2 }) })],
      ['spend increase below 15%', campaign({ current: metrics({ spend: 1_149, roas: 2 }) })],
      ['ROAS decline smaller than 20% and CPA increase smaller than 20%', campaign({ current: metrics({ spend: 1_200, roas: 3.21, cpa: 29.9 }) })],
      ['zero current spend', campaign({ current: metrics({ spend: 0, roas: 2, cpa: 50 }) })],
    ] as const)('suppresses campaign deterioration when %s', (_label, evidence) => {
      expect(campaignEfficiencyRule(evidence)).toBeNull();
    });

    it.each([
      ['frequency rises less than 20%', creative({ current: metrics({ frequency: 2.03, ctr: 0.02, cpa: 35 }) })],
      ['CTR falls less than 20%', creative({ current: metrics({ frequency: 2.2, ctr: 0.0241, cpa: 35 }) })],
      ['CPA and ROAS do not deteriorate enough', creative({ current: metrics({ frequency: 2.2, ctr: 0.02, cpa: 28.7, roas: 3.21 }) })],
      ['current impressions below 1,000', creative({ current: metrics({ impressions: 999, frequency: 2.2, ctr: 0.02, cpa: 35 }) })],
      ['comparison impressions below 1,000', creative({ comparison: metrics({ impressions: 999 }), current: metrics({ frequency: 2.2, ctr: 0.02, cpa: 35 }) })],
    ] as const)('suppresses creative fatigue when %s', (_label, evidence) => {
      expect(creativeFatigueRule(evidence)).toBeNull();
    });

    it.each([
      ['fewer than 5 units', product({ units: 4 })],
      ['mapping confidence below 0.70', product({ mappingConfidence: 0.69 })],
      ['revenue share below 8%', product({ revenueShare: 0.079 })],
      ['mapped paid share reaches 60% of revenue share', product({ revenueShare: 0.3, mappedSpendShare: 0.18 })],
    ] as const)('suppresses underexposed-product recommendation when %s', (_label, evidence) => {
      expect(underexposedProductRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      ['mapping confidence below 0.70', product({ revenueShare: 0.04, mappedSpendShare: 0.2, mappingConfidence: 0.69 })],
      ['mapped spend share below 8%', product({ revenueShare: 0.01, mappedSpendShare: 0.079 })],
      ['revenue share is more than 55% of mapped spend share', product({ revenueShare: 0.12, mappedSpendShare: 0.2 })],
      ['no commerce support and fewer than 1,000 paid impressions', product({ revenue: 0, netRevenue: 0, units: 0, revenueShare: 0, mappedImpressions: 999, mappedSpendShare: 0.3 })],
    ] as const)('suppresses paid-commerce mismatch when %s', (_label, evidence) => {
      expect(paidCommerceMismatchRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      ['cost coverage below 80%', product({ providerRoas: 3, contributionAfterAds: -100, costCoverage: 0.79 })],
      ['provider ROAS below 1.5', product({ providerRoas: 1.49, contributionAfterAds: -100 })],
      ['contribution after ads remains positive', product({ providerRoas: 3, contributionAfterAds: 1 })],
    ] as const)('suppresses margin trap when %s', (_label, evidence) => {
      expect(marginTrapRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      ['inventory is not explicitly trusted', product({ inventoryTrusted: false, daysCover: 4, recentUnitsPerDay: 5, mappedMetaSpend: 1_000 })],
      ['days cover exceeds 10', product({ inventoryTrusted: true, daysCover: 10.01, recentUnitsPerDay: 5, mappedMetaSpend: 1_000 })],
      ['days cover is negative', product({ inventoryTrusted: true, daysCover: -0.01, recentUnitsPerDay: 5, mappedMetaSpend: 1_000 })],
      ['mapped paid spend is zero', product({ inventoryTrusted: true, daysCover: 4, recentUnitsPerDay: 5, mappedMetaSpend: 0 })],
      ['recent sales velocity is zero', product({ inventoryTrusted: true, daysCover: 4, recentUnitsPerDay: 0, mappedMetaSpend: 1_000 })],
    ] as const)('suppresses direct inventory conflict when %s', (_label, evidence) => {
      expect(inventorySpendConflictRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      ['inventory is not trusted', shared({ inventoryTrusted: false })],
      ['shared spend is zero', shared({ sharedAdSpend: 0 })],
      ['impressions are below 1,000', shared({ impressions: 999 })],
      ['scope confidence is below 0.70 and merchant has not confirmed', shared({ scopeConfidence: 0.69, merchantConfirmed: false })],
      ['no promoted product has <=10 days cover with positive velocity', shared({ products: [{ entityId: 'healthy', externalEntityId: 'healthy', name: 'Healthy', stockAvailable: 100, recentUnitsPerDay: 2, daysCover: 50 }] })],
    ] as const)('suppresses shared-exposure inventory conflict when %s', (_label, evidence) => {
      expect(sharedExposureInventoryRule(evidence, productWindow)).toBeNull();
    });

    it('allows a merchant-confirmed shared scope even when algorithmic scope confidence is below 0.70', () => {
      const result = sharedExposureInventoryRule(
        shared({ scopeConfidence: 0.2, merchantConfirmed: true }),
        productWindow,
      );
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('shared_exposure_inventory_conflict');
    });
  });

  describe('benchmark-informed realistic stress scenario', () => {
    it('turns a realistic Meta baseline into a deterioration recommendation after spend scales into weaker economics', () => {
      // The comparison period is shaped around public 2026 ecommerce Meta benchmarks
      // (roughly 1.9 ROAS, ~2.4% CTR and ~$39 CPA), then the current period models
      // the exact failure mode Stride is meant to detect: spend rises while efficiency falls.
      const comparison = metrics({
        spend: 3_899,
        impressions: 258_898,
        clicks: 6_187,
        purchases: 100,
        purchaseValue: 7_330,
        roas: 1.88,
        cpa: 38.99,
        ctr: 0.0239,
        cpc: 0.63,
        cpm: 15.06,
        frequency: 1.8,
      });
      const current = metrics({
        spend: 4_900,
        impressions: 280_000,
        clicks: 5_040,
        purchases: 90,
        purchaseValue: 6_300,
        roas: 1.2857,
        cpa: 54.44,
        ctr: 0.018,
        cpc: 0.9722,
        cpm: 17.5,
        frequency: 2.15,
      });

      const result = campaignEfficiencyRule(campaign({ comparison, current, spendShare: 0.55 }));

      expectDecision(result, {
        ruleId: 'campaign_efficiency_deterioration',
        action: 'REDUCE',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
      expect(result?.evidence).toMatchObject({
        changes: expect.objectContaining({
          spend: expect.any(Number),
          roas: expect.any(Number),
          cpa: expect.any(Number),
          ctr: expect.any(Number),
          cpm: expect.any(Number),
        }),
      });
    });
  });
});
