import { describe, expect, it } from 'vitest';
import {
  type PaidEntityMetrics,
  unifiedPaidEntityConfidence,
  unifiedPaidEntitySignals,
} from '../../../src/modules/advertising/unified-paid-entity.service.js';

function metrics(overrides: Partial<PaidEntityMetrics> = {}): PaidEntityMetrics {
  return {
    evidenceAvailable: true,
    sourceRows: 7,
    spend: 100,
    impressions: 1000,
    clicks: 100,
    ctr: 0.1,
    cpc: 1,
    cpm: 100,
    providerConversions: 10,
    providerConversionValue: 300,
    providerRoas: 3,
    ...overrides,
  };
}

describe('unified paid entity evidence gates', () => {
  it('does not emit deterioration signals from thin current delivery', () => {
    const current = metrics({
      spend: 30,
      impressions: 40,
      clicks: 1,
      ctr: 0.025,
      cpc: 30,
      providerConversions: 0,
      providerConversionValue: 0,
      providerRoas: 0,
    });
    const comparison = metrics({ spend: 10, impressions: 40, clicks: 8, ctr: 0.2, cpc: 1.25 });

    expect(unifiedPaidEntityConfidence(current, comparison)).toBe('LOW');
    expect(unifiedPaidEntitySignals(current, comparison).map((signal) => signal.code)).toEqual([
      'LOW_DELIVERY_INSUFFICIENT_EVIDENCE',
    ]);
  });

  it('does not compare against a thin comparison period', () => {
    const current = metrics({ spend: 150, impressions: 1500, clicks: 75, ctr: 0.05, cpc: 2 });
    const comparison = metrics({ spend: 50, impressions: 50, clicks: 20, ctr: 0.4, cpc: 2.5 });

    expect(unifiedPaidEntityConfidence(current, comparison)).toBe('MEDIUM');
    expect(unifiedPaidEntitySignals(current, comparison)).toEqual([]);
  });

  it('emits deterioration when both periods have sufficient provider delivery evidence', () => {
    const current = metrics({
      spend: 150,
      impressions: 1500,
      clicks: 75,
      ctr: 0.05,
      cpc: 2,
      providerConversions: 6,
      providerConversionValue: 180,
      providerRoas: 1.2,
    });
    const comparison = metrics({
      spend: 100,
      impressions: 1500,
      clicks: 150,
      ctr: 0.1,
      cpc: 2 / 3,
      providerConversions: 10,
      providerConversionValue: 300,
      providerRoas: 3,
    });

    expect(unifiedPaidEntityConfidence(current, comparison)).toBe('HIGH');
    const codes = unifiedPaidEntitySignals(current, comparison).map((signal) => signal.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'SPEND_UP_EFFICIENCY_DOWN',
        'CPC_DETERIORATION',
        'CTR_DETERIORATION',
        'CONVERSIONS_DOWN_SPEND_UP',
      ]),
    );
  });

  it('requires substantial delivery before calling provider efficiency strong', () => {
    const current = metrics({
      impressions: 500,
      providerConversions: 10,
      providerRoas: 4,
    });
    const comparison = metrics({ impressions: 500, providerConversions: 8, providerRoas: 3 });
    expect(unifiedPaidEntitySignals(current, comparison).map((signal) => signal.code)).not.toContain(
      'STRONG_PROVIDER_EFFICIENCY',
    );

    const strongCurrent = metrics({ providerConversions: 10, providerRoas: 4 });
    const strongComparison = metrics({ providerConversions: 8, providerRoas: 3 });
    expect(
      unifiedPaidEntitySignals(strongCurrent, strongComparison).map((signal) => signal.code),
    ).toContain('STRONG_PROVIDER_EFFICIENCY');
  });
});
