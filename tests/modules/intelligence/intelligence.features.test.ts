import { describe, expect, it } from 'vitest';
import { candidateDecision } from '../../../src/modules/intelligence/intelligence.features.js';
import type {
  FinancialDecisionContext,
  MetricWindow,
} from '../../../src/modules/intelligence/intelligence.types.js';

function window(overrides: Partial<MetricWindow> = {}): MetricWindow {
  return {
    days: 7,
    observedDays: 7,
    spend: 1_000,
    impressions: 50_000,
    reach: 35_000,
    clicks: 1_500,
    outboundClicks: 1_200,
    conversions: 40,
    conversionValue: 4_000,
    ctr: 3,
    cpc: 0.67,
    cpm: 20,
    cvr: 3.33,
    cpa: 25,
    roas: 4,
    frequency: 1.4,
    ...overrides,
  };
}

function context(overrides: Partial<FinancialDecisionContext> = {}): FinancialDecisionContext {
  return {
    campaignRole: 'PROSPECTING',
    mappingConfidence: 0.98,
    attributionQuality: 'HIGH',
    inventoryRisk: 'HEALTHY',
    breakEvenRoas: 2,
    contributionMarginRatio: 0.5,
    commerceTrend: 'UP',
    dataFreshnessHours: 2,
    stabilizationComplete: true,
    ...overrides,
  };
}

describe('candidateDecision money-safety gates', () => {
  it('abstains when attribution quality is not high', () => {
    const decision = candidateDecision({
      recent: window(),
      previous: window({ roas: 3.5 }),
      confidence: 'HIGH',
      fatigue: 'LOW',
      context: context({ attributionQuality: 'MODERATE' }),
    });

    expect(decision.action).toBe('NO_RECOMMENDATION');
    expect(decision.financialAction).toBe(false);
    expect(decision.blockers).toContain('attribution quality is not HIGH');
  });

  it('abstains when unit economics are unavailable even with excellent ROAS', () => {
    const decision = candidateDecision({
      recent: window({ roas: 8 }),
      previous: window({ roas: 7 }),
      confidence: 'HIGH',
      fatigue: 'LOW',
      context: context({ breakEvenRoas: null, contributionMarginRatio: null }),
    });

    expect(decision.action).toBe('NO_RECOMMENDATION');
    expect(decision.financialAction).toBe(false);
  });

  it('does not apply direct-response budget logic to brand campaigns', () => {
    const decision = candidateDecision({
      recent: window({ roas: 8 }),
      previous: window({ roas: 7 }),
      confidence: 'HIGH',
      fatigue: 'LOW',
      context: context({ campaignRole: 'BRAND' }),
    });

    expect(decision.action).toBe('NO_RECOMMENDATION');
    expect(decision.blockers.some((blocker) => blocker.includes('campaign role'))).toBe(true);
  });

  it('holds when recent performance is strong but the previous window does not confirm it', () => {
    const decision = candidateDecision({
      recent: window({ roas: 4 }),
      previous: window({ roas: 1.9 }),
      confidence: 'HIGH',
      fatigue: 'LOW',
      context: context(),
    });

    expect(decision.action).toBe('HOLD');
    expect(decision.financialAction).toBe(false);
  });

  it('allows a scale candidate only when economics and independent windows agree', () => {
    const decision = candidateDecision({
      recent: window({ roas: 4 }),
      previous: window({ roas: 3 }),
      confidence: 'HIGH',
      fatigue: 'LOW',
      context: context(),
    });

    expect(decision.action).toBe('SCALE');
    expect(decision.financialAction).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision).not.toHaveProperty('maxSuggestedBudgetChangePercent');
  });

  it('abstains during the provider-specific stabilization period', () => {
    const decision = candidateDecision({
      recent: window({ roas: 5 }),
      previous: window({ roas: 4 }),
      confidence: 'HIGH',
      fatigue: 'LOW',
      context: context({ stabilizationComplete: false }),
    });

    expect(decision.action).toBe('NO_RECOMMENDATION');
    expect(decision.blockers.some((blocker) => blocker.includes('stabilization'))).toBe(true);
  });
});
