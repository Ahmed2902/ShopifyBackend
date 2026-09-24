import { describe, expect, it } from 'vitest';
import {
  legacyContributionAfterAds,
  legacyMer,
  legacySpendChange,
  resolveLegacyAdvertisingEvidence,
  type LegacyAdvertisingCurrencyBucket,
} from '../../../src/modules/analytics/legacy-ad-evidence.js';

function bucket(input: {
  currency?: string;
  current?: { sourceRows: number; spend: number };
  comparison?: { sourceRows: number; spend: number };
}): LegacyAdvertisingCurrencyBucket {
  return {
    currency: input.currency ?? 'USD',
    current: input.current ?? { sourceRows: 0, spend: 0 },
    comparison: input.comparison ?? { sourceRows: 0, spend: 0 },
  };
}

describe('legacy period-specific advertising evidence', () => {
  it.each([
    {
      name: 'current evidence and missing comparison',
      currencies: [
        bucket({
          current: { sourceRows: 1, spend: 500 },
          comparison: { sourceRows: 0, spend: 0 },
        }),
      ],
      currentAvailable: true,
      comparisonAvailable: false,
      currentMer: 2,
      comparisonMer: null,
      currentContribution: 500,
      comparisonContribution: null,
      spendChange: null,
    },
    {
      name: 'missing current and comparison evidence',
      currencies: [
        bucket({
          current: { sourceRows: 0, spend: 0 },
          comparison: { sourceRows: 1, spend: 250 },
        }),
      ],
      currentAvailable: false,
      comparisonAvailable: true,
      currentMer: null,
      comparisonMer: 4,
      currentContribution: null,
      comparisonContribution: 750,
      spendChange: null,
    },
    {
      name: 'both periods missing',
      currencies: [],
      currentAvailable: false,
      comparisonAvailable: false,
      currentMer: null,
      comparisonMer: null,
      currentContribution: null,
      comparisonContribution: null,
      spendChange: null,
    },
    {
      name: 'both periods present',
      currencies: [
        bucket({
          current: { sourceRows: 2, spend: 500 },
          comparison: { sourceRows: 1, spend: 250 },
        }),
      ],
      currentAvailable: true,
      comparisonAvailable: true,
      currentMer: 2,
      comparisonMer: 4,
      currentContribution: 500,
      comparisonContribution: 750,
      spendChange: 1,
    },
    {
      name: 'true reported zero in both periods',
      currencies: [
        bucket({
          current: { sourceRows: 1, spend: 0 },
          comparison: { sourceRows: 1, spend: 0 },
        }),
      ],
      currentAvailable: true,
      comparisonAvailable: true,
      currentMer: null,
      comparisonMer: null,
      currentContribution: 1000,
      comparisonContribution: 1000,
      spendChange: 0,
    },
    {
      name: 'true current zero and missing comparison',
      currencies: [
        bucket({
          current: { sourceRows: 1, spend: 0 },
          comparison: { sourceRows: 0, spend: 0 },
        }),
      ],
      currentAvailable: true,
      comparisonAvailable: false,
      currentMer: null,
      comparisonMer: null,
      currentContribution: 1000,
      comparisonContribution: null,
      spendChange: null,
    },
    {
      name: 'store currency exists in only one period',
      currencies: [
        bucket({
          current: { sourceRows: 3, spend: 75 },
          comparison: { sourceRows: 0, spend: 0 },
        }),
      ],
      currentAvailable: true,
      comparisonAvailable: false,
      currentMer: 1000 / 75,
      comparisonMer: null,
      currentContribution: 925,
      comparisonContribution: null,
      spendChange: null,
    },
    {
      name: 'other currencies do not make missing store-currency comparison available',
      currencies: [
        bucket({
          current: { sourceRows: 1, spend: 100 },
          comparison: { sourceRows: 0, spend: 0 },
        }),
        bucket({
          currency: 'EUR',
          current: { sourceRows: 0, spend: 0 },
          comparison: { sourceRows: 2, spend: 900 },
        }),
      ],
      currentAvailable: true,
      comparisonAvailable: false,
      currentMer: 10,
      comparisonMer: null,
      currentContribution: 900,
      comparisonContribution: null,
      spendChange: null,
    },
  ])('$name', (scenario) => {
    const evidence = resolveLegacyAdvertisingEvidence(scenario.currencies, 'USD');

    expect(evidence.current.evidenceAvailable).toBe(scenario.currentAvailable);
    expect(evidence.comparison.evidenceAvailable).toBe(scenario.comparisonAvailable);
    expect(legacyMer(1000, evidence.current)).toBe(scenario.currentMer);
    expect(legacyMer(1000, evidence.comparison)).toBe(scenario.comparisonMer);
    expect(legacyContributionAfterAds(1000, evidence.current)).toBe(
      scenario.currentContribution,
    );
    expect(legacyContributionAfterAds(1000, evidence.comparison)).toBe(
      scenario.comparisonContribution,
    );
    expect(legacySpendChange(evidence.current, evidence.comparison)).toBe(
      scenario.spendChange,
    );
  });

  it('keeps a compatibility zero distinguishable from provider-reported zero', () => {
    const missing = resolveLegacyAdvertisingEvidence([], 'USD');
    const reportedZero = resolveLegacyAdvertisingEvidence(
      [
        bucket({
          current: { sourceRows: 1, spend: 0 },
          comparison: { sourceRows: 1, spend: 0 },
        }),
      ],
      'USD',
    );

    expect(missing.current).toEqual({ evidenceAvailable: false, spend: 0 });
    expect(reportedZero.current).toEqual({ evidenceAvailable: true, spend: 0 });
  });
});
