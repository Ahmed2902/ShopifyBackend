import { describe, expect, it } from 'vitest';
import {
  resolveAnalyticsWindows,
  resolveLiveAnalyticsWindows,
} from '../../../src/modules/analytics/analytics.dates.js';

describe('resolveAnalyticsWindows', () => {
  it('uses completed store-local days and an equal previous comparison window', () => {
    const result = resolveAnalyticsWindows(
      { days: 7 },
      'Africa/Cairo',
      new Date('2026-09-03T18:00:00.000Z'),
    );

    expect(result.current.fromDate).toBe('2026-08-27');
    expect(result.current.toDate).toBe('2026-09-02');
    expect(result.comparison.fromDate).toBe('2026-08-20');
    expect(result.comparison.toDate).toBe('2026-08-26');
    expect(result.days).toBe(7);
  });

  it('builds the comparison directly before an explicit range', () => {
    const result = resolveAnalyticsWindows(
      { from: '2026-08-01', to: '2026-08-10', days: 30 },
      'UTC',
    );

    expect(result.current.fromDate).toBe('2026-08-01');
    expect(result.current.toDate).toBe('2026-08-10');
    expect(result.comparison.fromDate).toBe('2026-07-22');
    expect(result.comparison.toDate).toBe('2026-07-31');
    expect(result.days).toBe(10);
  });
});

describe('resolveLiveAnalyticsWindows', () => {
  it('includes the current store-local day for continuously rolled-up pixel analytics', () => {
    const result = resolveLiveAnalyticsWindows(
      { days: 7 },
      'Africa/Cairo',
      new Date('2026-09-11T23:30:00.000Z'),
    );

    expect(result.current.fromDate).toBe('2026-09-06');
    expect(result.current.toDate).toBe('2026-09-12');
    expect(result.comparison.fromDate).toBe('2026-08-30');
    expect(result.comparison.toDate).toBe('2026-09-05');
    expect(result.days).toBe(7);
  });

  it('preserves explicit date ranges for live analytics', () => {
    const result = resolveLiveAnalyticsWindows(
      { from: '2026-09-01', to: '2026-09-05', days: 30 },
      'Africa/Cairo',
      new Date('2026-09-11T23:30:00.000Z'),
    );

    expect(result.current.fromDate).toBe('2026-09-01');
    expect(result.current.toDate).toBe('2026-09-05');
    expect(result.comparison.fromDate).toBe('2026-08-27');
    expect(result.comparison.toDate).toBe('2026-08-31');
  });
});
