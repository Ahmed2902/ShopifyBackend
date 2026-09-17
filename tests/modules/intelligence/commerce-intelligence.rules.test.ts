import { describe, expect, it } from 'vitest';
import {
  discountDependencyRule,
  refundDeteriorationRule,
  returningCustomerDeteriorationRule,
  type CommerceDecisionEvidence,
} from '../../../src/modules/intelligence/commerce-intelligence.rules.js';

function evidence(): CommerceDecisionEvidence {
  return {
    currency: 'USD',
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-30T23:59:59.999Z'),
    comparisonStart: new Date('2026-08-02T00:00:00.000Z'),
    comparisonEnd: new Date('2026-08-31T23:59:59.999Z'),
    classificationCoverageCurrent: 0.95,
    classificationCoverageComparison: 0.96,
    current: { orders: 200, orderValue: 18_000, refunds: 2_000, discounts: 3_000, returningOrders: 50, unknownCustomerOrders: 10 },
    comparison: { orders: 200, orderValue: 19_000, refunds: 1_000, discounts: 1_000, returningOrders: 90, unknownCustomerOrders: 8 },
  };
}

describe('commerce intelligence rules', () => {
  it('flags refund pressure', () => expect(refundDeteriorationRule(evidence())?.ruleId).toBe('refund_rate_deterioration'));
  it('flags discount dependency', () => expect(discountDependencyRule(evidence())?.ruleId).toBe('discount_dependency_deterioration'));
  it('flags returning-order deterioration', () => expect(returningCustomerDeteriorationRule(evidence())?.ruleId).toBe('returning_customer_deterioration'));
  it('suppresses returning-order diagnosis without classification coverage', () => {
    const input = evidence();
    input.classificationCoverageCurrent = 0.5;
    expect(returningCustomerDeteriorationRule(input)).toBeNull();
  });
});
