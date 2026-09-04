import { describe, expect, it } from 'vitest';
import {
  campaignEfficiencyRule,
  creativeFatigueRule,
  inventorySpendConflictRule,
  marginTrapRule,
  paidCommerceMismatchRule,
  underexposedProductRule,
} from '../../../src/modules/intelligence/intelligence.rules.js';
import type {
  CampaignEvidence,
  CreativeEvidence,
  HistoricalMetrics,
  ProductEvidence,
} from '../../../src/modules/intelligence/intelligence.types.js';

const start = new Date('2026-08-17T00:00:00.000Z');
const end = new Date('2026-08-23T00:00:00.000Z');

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
    cpc: 1.67,
    cpm: 50,
    frequency: 1.7,
    ...overrides,
  };
}

function campaign(overrides: Partial<CampaignEvidence> = {}): CampaignEvidence {
  return {
    entityId: 'campaign-local',
    externalEntityId: 'campaign-meta',
    name: 'Prospecting',
    currency: 'USD',
    spendShare: 0.4,
    start,
    end,
    current: metrics(),
    comparison: metrics(),
    ...overrides,
  };
}

function creative(overrides: Partial<CreativeEvidence> = {}): CreativeEvidence {
  return {
    entityId: 'creative-local',
    externalEntityId: 'creative-meta',
    name: 'UGC 1',
    currency: 'USD',
    spendShare: 0.25,
    start,
    end,
    current: metrics(),
    comparison: metrics(),
    ...overrides,
  };
}

function product(overrides: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    entityId: 'product-local',
    externalEntityId: 'product-shopify',
    name: 'Core Tee',
    currency: 'USD',
    revenue: 8_000,
    netRevenue: 7_800,
    units: 100,
    revenueShare: 0.25,
    mappedMetaSpend: 600,
    mappedImpressions: 12_000,
    mappedSpendShare: 0.05,
    mappedProviderValue: 2_400,
    providerRoas: 4,
    mappingConfidence: 0.9,
    mappingCoverage: 0.8,
    contributionBeforeAds: 3_000,
    contributionAfterAds: 2_400,
    costCoverage: 0.95,
    inventoryTrusted: false,
    stockAvailable: null,
    recentUnitsPerDay: null,
    daysCover: null,
    ...overrides,
  };
}

describe('V1 deterministic intelligence rules', () => {
  it('flags campaign efficiency deterioration only with meaningful support and spend expansion', () => {
    const flagged = campaignEfficiencyRule(
      campaign({
        current: metrics({ spend: 1_300, purchaseValue: 3_500, roas: 2.69, cpa: 35, ctr: 0.024 }),
      }),
    );
    expect(flagged).toMatchObject({
      ruleId: 'campaign_efficiency_deterioration',
      category: 'CAMPAIGN_EFFICIENCY',
      entityType: 'CAMPAIGN',
    });

    expect(
      campaignEfficiencyRule(
        campaign({ current: metrics({ spend: 1_300, impressions: 500, roas: 2.5 }) }),
      ),
    ).toBeNull();
    expect(
      campaignEfficiencyRule(campaign({ current: metrics({ spend: 1_050, roas: 2.5 }) })),
    ).toBeNull();
  });

  it('requires rising repeat exposure plus weaker engagement and efficiency for fatigue symptoms', () => {
    expect(
      creativeFatigueRule(
        creative({
          current: metrics({ frequency: 2.4, ctr: 0.021, cpa: 33, roas: 3 }),
        }),
      ),
    ).toMatchObject({
      ruleId: 'creative_fatigue_symptoms',
      category: 'CREATIVE_FATIGUE',
    });

    expect(
      creativeFatigueRule(
        creative({ current: metrics({ frequency: 1.8, ctr: 0.021, cpa: 33, roas: 3 }) }),
      ),
    ).toBeNull();
  });

  it('gates Product × Ads opportunity and mismatch rules on mapping quality', () => {
    expect(underexposedProductRule(product(), { start, end })).not.toBeNull();
    expect(
      underexposedProductRule(product({ mappingConfidence: 0.5 }), { start, end }),
    ).toBeNull();

    const mismatch = product({
      revenueShare: 0.04,
      mappedSpendShare: 0.2,
      mappedMetaSpend: 2_400,
    });
    expect(paidCommerceMismatchRule(mismatch, { start, end })).not.toBeNull();
    expect(
      paidCommerceMismatchRule({ ...mismatch, mappingCoverage: 0.4 }, { start, end }),
    ).toBeNull();
  });

  it('can flag meaningful paid exposure with zero observed Shopify sales', () => {
    const mismatch = product({
      revenue: 0,
      netRevenue: 0,
      units: 0,
      revenueShare: 0,
      mappedMetaSpend: 2_400,
      mappedImpressions: 20_000,
      mappedSpendShare: 0.3,
      mappedProviderValue: 0,
      providerRoas: 0,
      contributionBeforeAds: null,
      contributionAfterAds: null,
      costCoverage: 0,
    });

    expect(paidCommerceMismatchRule(mismatch, { start, end })).toMatchObject({
      ruleId: 'paid_commerce_exposure_mismatch',
      category: 'PAID_COMMERCE_MISMATCH',
    });
    expect(
      paidCommerceMismatchRule({ ...mismatch, mappedImpressions: 200 }, { start, end }),
    ).toBeNull();
  });

  it('does not emit a margin trap until cost coverage is sufficient', () => {
    const trap = product({ contributionAfterAds: -200, providerRoas: 3.2 });
    expect(marginTrapRule(trap, { start, end })).toMatchObject({ category: 'MARGIN_TRAP' });
    expect(
      marginTrapRule({ ...trap, costCoverage: 0.6 }, { start, end }),
    ).toBeNull();
  });

  it('never uses inventory for spend guidance unless the merchant marked it trusted', () => {
    const lowCover = product({
      mappedMetaSpend: 1_000,
      inventoryTrusted: false,
      stockAvailable: 20,
      recentUnitsPerDay: 5,
      daysCover: 4,
    });
    expect(inventorySpendConflictRule(lowCover, { start, end })).toBeNull();
    expect(
      inventorySpendConflictRule({ ...lowCover, inventoryTrusted: true }, { start, end }),
    ).toMatchObject({
      category: 'INVENTORY_SPEND_CONFLICT',
      severity: 'CRITICAL',
    });
  });
});
