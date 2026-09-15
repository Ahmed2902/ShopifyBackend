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

function check(
  recommendation: RecommendationDraft | null,
  expected: {
    ruleId: string;
    action: string;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    severity?: string;
  },
) {
  expect(recommendation).not.toBeNull();
  expect(recommendation).toMatchObject({
    ruleId: expected.ruleId,
    ...(expected.severity ? { severity: expected.severity } : {}),
  });
  expect(recommendationDecision(recommendation!)).toMatchObject({
    decisionAction: expected.action,
    decisionConfidence: expected.confidence,
    decisionBasis: 'DETERMINISTIC_RULE',
  });
}

describe('intelligence scenario matrix', () => {
  describe('positive recommendation paths', () => {
    it('campaign deterioration HIGH -> REDUCE', () => {
      check(
        campaignEfficiencyRule(
          campaign({
            current: metrics({
              spend: 1_400,
              roas: 2.28,
              cpa: 56,
              ctr: 0.022,
              cpm: 70,
            }),
          }),
        ),
        {
          ruleId: 'campaign_efficiency_deterioration',
          action: 'REDUCE',
          confidence: 'HIGH',
          severity: 'HIGH',
        },
      );
    });

    it('campaign deterioration MEDIUM -> HOLD', () => {
      check(
        campaignEfficiencyRule(
          campaign({ current: metrics({ spend: 1_200, roas: 3.08, cpa: 30.5 }) }),
        ),
        {
          ruleId: 'campaign_efficiency_deterioration',
          action: 'HOLD',
          confidence: 'HIGH',
          severity: 'MEDIUM',
        },
      );
    });

    it('creative fatigue -> TEST', () => {
      check(
        creativeFatigueRule(
          creative({
            comparison: metrics({ frequency: 1.5, ctr: 0.03, cpa: 25, roas: 4 }),
            current: metrics({ frequency: 2.3, ctr: 0.02, cpa: 36, roas: 2.9 }),
          }),
        ),
        {
          ruleId: 'creative_fatigue_symptoms',
          action: 'TEST',
          confidence: 'HIGH',
          severity: 'HIGH',
        },
      );
    });

    it('underexposed product MEDIUM -> TEST', () => {
      check(underexposedProductRule(product(), productWindow), {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'HIGH',
        severity: 'MEDIUM',
      });
    });

    it('underexposed product HIGH -> TEST', () => {
      check(
        underexposedProductRule(
          product({ revenueShare: 0.35, mappedSpendShare: 0.08 }),
          productWindow,
        ),
        {
          ruleId: 'underexposed_commerce_winner',
          action: 'TEST',
          confidence: 'HIGH',
          severity: 'HIGH',
        },
      );
    });

    it('paid-commerce mismatch -> INVESTIGATE', () => {
      check(
        paidCommerceMismatchRule(
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
        ),
        {
          ruleId: 'paid_commerce_exposure_mismatch',
          action: 'INVESTIGATE',
          confidence: 'HIGH',
          severity: 'HIGH',
        },
      );
    });

    it('paid-commerce mismatch can fire with zero observed Shopify sales when paid support is strong', () => {
      check(
        paidCommerceMismatchRule(
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
        ),
        {
          ruleId: 'paid_commerce_exposure_mismatch',
          action: 'INVESTIGATE',
          confidence: 'HIGH',
          severity: 'HIGH',
        },
      );
    });

    it('margin trap -> REDUCE', () => {
      check(
        marginTrapRule(
          product({
            revenue: 15_000,
            netRevenue: 15_000,
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
        ),
        {
          ruleId: 'provider_roas_margin_trap',
          action: 'REDUCE',
          confidence: 'HIGH',
          severity: 'HIGH',
        },
      );
    });

    it('direct inventory <=5 days -> CRITICAL HOLD', () => {
      check(
        inventorySpendConflictRule(
          product({
            inventoryTrusted: true,
            stockAvailable: 20,
            recentUnitsPerDay: 5,
            daysCover: 4,
            mappedMetaSpend: 1_500,
          }),
          productWindow,
        ),
        {
          ruleId: 'inventory_spend_conflict',
          action: 'HOLD',
          confidence: 'MEDIUM',
          severity: 'CRITICAL',
        },
      );
    });

    it('direct inventory 5-10 days -> HIGH HOLD', () => {
      check(
        inventorySpendConflictRule(
          product({
            inventoryTrusted: true,
            stockAvailable: 40,
            recentUnitsPerDay: 5,
            daysCover: 8,
            mappedMetaSpend: 1_500,
          }),
          productWindow,
        ),
        {
          ruleId: 'inventory_spend_conflict',
          action: 'HOLD',
          confidence: 'MEDIUM',
          severity: 'HIGH',
        },
      );
    });

    it('shared multi-product inventory -> HOLD without product-level spend fabrication', () => {
      const result = sharedExposureInventoryRule(shared(), productWindow);
      check(result, {
        ruleId: 'shared_exposure_inventory_conflict',
        action: 'HOLD',
        confidence: 'MEDIUM',
        severity: 'CRITICAL',
      });
      expect(result?.limitations).toContainEqual(
        expect.objectContaining({ code: 'SHARED_SPEND_NOT_ALLOCATED' }),
      );
      expect(result?.evidence).not.toHaveProperty('productSpend');
    });

    it('collection inventory -> HOLD with bounded-membership limitations', () => {
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
      check(result, {
        ruleId: 'shared_exposure_inventory_conflict',
        action: 'HOLD',
        confidence: 'MEDIUM',
        severity: 'CRITICAL',
      });
      expect(result?.limitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SHARED_SPEND_NOT_ALLOCATED' }),
          expect.objectContaining({ code: 'CURRENT_COLLECTION_MEMBERSHIP' }),
          expect.objectContaining({ code: 'COLLECTION_MEMBERSHIP_TRUNCATED' }),
        ]),
      );
    });
  });

  describe('confidence degradation', () => {
    it('partial mapping coverage -> MEDIUM confidence', () => {
      const result = underexposedProductRule(product({ mappingCoverage: 0.4 }), productWindow);
      check(result, {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'MEDIUM',
      });
      expect(result?.limitations).toContainEqual(
        expect.objectContaining({ code: 'MAPPING_COVERAGE_PARTIAL' }),
      );
    });

    it('very low mapping coverage -> LOW confidence', () => {
      const result = underexposedProductRule(product({ mappingCoverage: 0.2 }), productWindow);
      check(result, {
        ruleId: 'underexposed_commerce_winner',
        action: 'TEST',
        confidence: 'LOW',
      });
      expect(result?.limitations).toContainEqual(
        expect.objectContaining({ code: 'MAPPING_COVERAGE_VERY_LOW' }),
      );
    });
  });

  describe('threshold and suppression coverage', () => {
    it.each([
      campaign({ current: metrics({ impressions: 999, spend: 1_400, roas: 2 }) }),
      campaign({ comparison: metrics({ impressions: 999 }), current: metrics({ spend: 1_400, roas: 2 }) }),
      campaign({ current: metrics({ spend: 1_149, roas: 2 }) }),
      campaign({ current: metrics({ spend: 1_200, roas: 3.21, cpa: 29.9 }) }),
      campaign({ current: metrics({ spend: 0, roas: 2, cpa: 50 }) }),
    ])('suppresses campaign scenario %# when support/thresholds are insufficient', (evidence) => {
      expect(campaignEfficiencyRule(evidence)).toBeNull();
    });

    it.each([
      creative({ current: metrics({ frequency: 2.03, ctr: 0.02, cpa: 35 }) }),
      creative({ current: metrics({ frequency: 2.2, ctr: 0.0241, cpa: 35 }) }),
      creative({ current: metrics({ frequency: 2.2, ctr: 0.02, cpa: 28.7, roas: 3.21 }) }),
      creative({ current: metrics({ impressions: 999, frequency: 2.2, ctr: 0.02, cpa: 35 }) }),
      creative({ comparison: metrics({ impressions: 999 }), current: metrics({ frequency: 2.2, ctr: 0.02, cpa: 35 }) }),
    ])('suppresses creative scenario %# when one fatigue leg is missing', (evidence) => {
      expect(creativeFatigueRule(evidence)).toBeNull();
    });

    it.each([
      product({ units: 4 }),
      product({ mappingConfidence: 0.69 }),
      product({ revenueShare: 0.079 }),
      product({ revenueShare: 0.3, mappedSpendShare: 0.18 }),
    ])('suppresses underexposed scenario %# at/below hard gates', (evidence) => {
      expect(underexposedProductRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      product({ revenueShare: 0.04, mappedSpendShare: 0.2, mappingConfidence: 0.69 }),
      product({ revenueShare: 0.01, mappedSpendShare: 0.079 }),
      product({ revenueShare: 0.12, mappedSpendShare: 0.2 }),
      product({ revenue: 0, netRevenue: 0, units: 0, revenueShare: 0, mappedImpressions: 999, mappedSpendShare: 0.3 }),
    ])('suppresses mismatch scenario %# at/below hard gates', (evidence) => {
      expect(paidCommerceMismatchRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      product({ providerRoas: 3, contributionAfterAds: -100, costCoverage: 0.79 }),
      product({ providerRoas: 1.49, contributionAfterAds: -100 }),
      product({ providerRoas: 3, contributionAfterAds: 1 }),
    ])('suppresses margin-trap scenario %# without sufficient economics evidence', (evidence) => {
      expect(marginTrapRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      product({ inventoryTrusted: false, daysCover: 4, recentUnitsPerDay: 5, mappedMetaSpend: 1_000 }),
      product({ inventoryTrusted: true, daysCover: 10.01, recentUnitsPerDay: 5, mappedMetaSpend: 1_000 }),
      product({ inventoryTrusted: true, daysCover: -0.01, recentUnitsPerDay: 5, mappedMetaSpend: 1_000 }),
      product({ inventoryTrusted: true, daysCover: 4, recentUnitsPerDay: 5, mappedMetaSpend: 0 }),
      product({ inventoryTrusted: true, daysCover: 4, recentUnitsPerDay: 0, mappedMetaSpend: 1_000 }),
    ])('suppresses direct inventory scenario %# when a safety prerequisite is missing', (evidence) => {
      expect(inventorySpendConflictRule(evidence, productWindow)).toBeNull();
    });

    it.each([
      shared({ inventoryTrusted: false }),
      shared({ sharedAdSpend: 0 }),
      shared({ impressions: 999 }),
      shared({ scopeConfidence: 0.69, merchantConfirmed: false }),
      shared({ products: [{ entityId: 'healthy', externalEntityId: 'healthy', name: 'Healthy', stockAvailable: 100, recentUnitsPerDay: 2, daysCover: 50 }] }),
    ])('suppresses shared inventory scenario %# when evidence is insufficient', (evidence) => {
      expect(sharedExposureInventoryRule(evidence, productWindow)).toBeNull();
    });

    it('accepts merchant confirmation as the shared-scope confidence override', () => {
      expect(
        sharedExposureInventoryRule(
          shared({ scopeConfidence: 0.2, merchantConfirmed: true }),
          productWindow,
        ),
      ).not.toBeNull();
    });
  });

  describe('benchmark-informed stress profile', () => {
    it('detects deterioration from a realistic 2026 ecommerce Meta baseline', () => {
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

      check(campaignEfficiencyRule(campaign({ comparison, current, spendShare: 0.55 })), {
        ruleId: 'campaign_efficiency_deterioration',
        action: 'REDUCE',
        confidence: 'HIGH',
        severity: 'HIGH',
      });
    });
  });
});
