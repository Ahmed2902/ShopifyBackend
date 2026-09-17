import { describe, expect, it } from 'vitest';
import { videoRetentionDeteriorationRule } from '../../../src/modules/intelligence/creative-retention-intelligence.rules.js';
import { adEfficiencyDeteriorationRule } from '../../../src/modules/intelligence/paid-entity-intelligence.rules.js';
import type { CreativeEvidence } from '../../../src/modules/intelligence/intelligence.types.js';
import type { CreativeVideoRetention } from '../../../src/modules/analytics/creative-video-retention.service.js';

const window = {
  currentStart: new Date('2026-09-01T00:00:00.000Z'),
  currentEnd: new Date('2026-09-07T23:59:59.999Z'),
  comparisonStart: new Date('2026-08-25T00:00:00.000Z'),
  comparisonEnd: new Date('2026-08-31T23:59:59.999Z'),
};

describe('expanded paid intelligence rules', () => {
  it('detects ad-level efficiency deterioration', () => {
    const result = adEfficiencyDeteriorationRule(
      {
        entityId: 'ad-1',
        externalEntityId: '1001',
        name: 'Hero ad',
        currency: 'USD',
        spendShare: 0.35,
        current: {
          spend: 150,
          impressions: 5_000,
          reach: null,
          clicks: 100,
          purchases: 5,
          purchaseValue: 250,
          roas: 1.67,
          cpa: 30,
          ctr: 0.02,
          cpc: 1.5,
          cpm: 30,
          frequency: 2.2,
        },
        comparison: {
          spend: 100,
          impressions: 5_000,
          reach: null,
          clicks: 150,
          purchases: 8,
          purchaseValue: 300,
          roas: 3,
          cpa: 12.5,
          ctr: 0.03,
          cpc: 0.67,
          cpm: 20,
          frequency: 1.8,
        },
      },
      window,
    );
    expect(result).toMatchObject({ ruleId: 'ad_efficiency_deterioration', entityType: 'AD' });
  });

  it('detects supported video-retention deterioration', () => {
    const creative: CreativeEvidence = {
      entityId: 'creative-1',
      externalEntityId: '2001',
      name: 'Video creative',
      currency: 'USD',
      spendShare: 0.3,
      start: window.currentStart,
      end: window.currentEnd,
      current: {} as CreativeEvidence['current'],
      comparison: {} as CreativeEvidence['comparison'],
    };
    const period = (to25: number, completion: number) => ({
      plays: 2_000,
      watched25: Math.round(2_000 * to25),
      watched50: 900,
      watched75: 500,
      watched95: 300,
      watched100: Math.round(2_000 * completion),
      thruplays: 700,
      watched30Seconds: 600,
      averageTimeWatchedSeconds: 9,
      rates: { to25, to50: 0.45, to75: 0.25, to95: 0.15, completion },
      transitions: { startTo25: to25, p25To50: 0.6, p50To75: 0.55, p75To100: 0.5 },
      largestDropStage: 'START_TO_25' as const,
      largestDropRate: 1 - to25,
    });
    const retention: CreativeVideoRetention = {
      source: 'META_VIDEO_INSIGHTS',
      status: 'READY',
      evidenceQuality: 'HIGH',
      minimumDiagnosticPlays: 100,
      current: period(0.55, 0.18),
      comparison: period(0.75, 0.35),
      change: {
        to25RatePoints: -0.2,
        to50RatePoints: 0,
        to75RatePoints: 0,
        completionRatePoints: -0.17,
        averageTimeWatchedSeconds: -2,
      },
      limitations: [],
      interpretation: 'Observed',
    };

    expect(videoRetentionDeteriorationRule(creative, retention, window)).toMatchObject({
      ruleId: 'video_retention_deterioration',
      category: 'VIDEO_RETENTION',
    });
  });
});
