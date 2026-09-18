import { describe, expect, it } from 'vitest';
import {
  discountDependencyDeteriorationRule,
  inventoryRunwayRiskRule,
  mappingCoverageDegradedRule,
  refundRateDeteriorationRule,
  returningCustomerDeteriorationRule,
} from '../../../src/modules/intelligence/commerce-intelligence.rules.js';
import type {
  CommerceHealthEvidence,
  ProductEvidence,
} from '../../../src/modules/intelligence/intelligence.types.js';

const decisionWindow = {
  currentStart: new Date('2026-09-01T00:00:00.000Z'),
  currentEnd: new Date('2026-09-07T23:59:59.999Z'),
  comparisonStart: new Date('2026-08-25T00:00:00.000Z'),
  comparisonEnd: new Date('2026-08-31T23:59:59.999Z'),
};

function commerce(overrides: Partial<CommerceHealthEvidence> = {}): CommerceHealthEvidence {
  return {
    current: {
      orders: 100,
      orderValue: 10_000,
      refunds: 1_000,
      discounts: 1_500,
      refundRate: 0.091,
      discountRate: 0.13,
      newOrders: 55,
      returningOrders: 40,
      unknownCustomerOrders: 5,
      knownCustomerCoverage: 0.95,
      returningOrderShare: 0.421,
    },
    comparison: {
      orders: 100,
      orderValue: 10_000,
      refunds: 300,
      discounts: 700,
      refundRate: 0.029,
      discountRate: 0.065,
      newOrders: 45,
      returningOrders: 50,
      unknownCustomerOrders: 5,
      knownCustomerCoverage: 0.95,
      returningOrderShare: 0.526,
    },
    ...overrides,
  };
}

function product(overrides: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    entityId: 'product-1',
    externalEntityId: 'gid://shopify/Product/1',
    name: 'Hero product',
    currency: 'USD',
    revenue: 4_000,
    netRevenue: 3_800,
    units: 20,
    revenueShare: 0.2,
    mappedMetaSpend: 0,
    mappedImpressions: 0,
    mappedSpendShare: 0,
    mappedProviderValue: 0,
    providerRoas: null,
    mappingConfidence: 0,
    mappingCoverage: 0,
    contributionBeforeAds: 2_000,
    contributionAfterAds: 2_000,
    costCoverage: 1,
    inventoryTrusted: true,
    stockAvailable: 12,
    recentUnitsPerDay: 3,
    daysCover: 4,
    ...overrides,
  };
}

describe('commerce intelligence rules', () => {
  it('detects refund pressure', () => {
    expect(refundRateDeteriorationRule(commerce(), decisionWindow)).toMatchObject({
      ruleId: 'refund_rate_deterioration',
      category: 'COMMERCE_HEALTH',
    });
  });

  it('detects higher discount dependence', () => {
    expect(discountDependencyDeteriorationRule(commerce(), decisionWindow)).toMatchObject({
      ruleId: 'discount_dependency_deterioration',
    });
  });

  it('detects returning-order share deterioration only with strong classification coverage', () => {
    expect(returningCustomerDeteriorationRule(commerce(), decisionWindow)).toMatchObject({
      ruleId: 'returning_customer_deterioration',
    });
    const thinCoverage = commerce();
    thinCoverage.current.knownCustomerCoverage = 0.5;
    expect(returningCustomerDeteriorationRule(thinCoverage, decisionWindow)).toBeNull();
  });

  it('flags trusted inventory runway without duplicating mapped-spend conflicts', () => {
    expect(
      inventoryRunwayRiskRule(product(), { start: decisionWindow.currentStart, end: decisionWindow.currentEnd }),
    ).toMatchObject({ ruleId: 'inventory_runway_risk', category: 'INVENTORY_RISK' });
    expect(
      inventoryRunwayRiskRule(product({ mappedMetaSpend: 100 }), {
        start: decisionWindow.currentStart,
        end: decisionWindow.currentEnd,
      }),
    ).toBeNull();
  });

  it('turns materially low mapping coverage into an explicit workflow', () => {
    expect(
      mappingCoverageDegradedRule({
        mappingCoverage: 0.25,
        totalMetaSpend: 1_000,
        window: { start: decisionWindow.currentStart, end: decisionWindow.currentEnd },
      }),
    ).toMatchObject({ ruleId: 'mapping_coverage_degraded', severity: 'HIGH' });
  });
});
