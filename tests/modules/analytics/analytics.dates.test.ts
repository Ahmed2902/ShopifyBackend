import { describe, expect, it } from 'vitest';
import { resolveAnalyticsWindows } from '../../../src/modules/analytics/analytics.dates.js';

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
