import { AppError } from '../../errors/app-error.js';
import {
  addDateDays,
  completedWindow,
  dateWindow,
  type HistoricalDateWindow,
} from '../intelligence/intelligence.dates.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';

export interface AnalyticsWindows {
  current: HistoricalDateWindow;
  comparison: HistoricalDateWindow;
  days: number;
}

function inclusiveDays(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function resolveAnalyticsWindows(
  query: AnalyticsRangeQuery,
  timeZone: string,
  now = new Date(),
): AnalyticsWindows {
  if (!query.from || !query.to) {
    const current = completedWindow(now, timeZone, query.days);
    return {
      current,
      comparison: completedWindow(now, timeZone, query.days, query.days),
      days: query.days,
    };
  }

  const days = inclusiveDays(query.from, query.to);
  if (days < 1 || days > 365) {
    throw new AppError('Analytics range must be between 1 and 365 days', 400, 'INVALID_DATE_RANGE');
  }

  const current = dateWindow(query.from, query.to, timeZone);
  const comparisonTo = addDateDays(query.from, -1);
  const comparisonFrom = addDateDays(comparisonTo, -(days - 1));
  return {
    current,
    comparison: dateWindow(comparisonFrom, comparisonTo, timeZone),
    days,
  };
}
