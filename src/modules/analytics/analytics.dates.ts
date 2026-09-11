import { AppError } from '../../errors/app-error.js';
import {
  addDateDays,
  completedWindow,
  dateWindow,
  storeDate,
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

function explicitWindows(query: AnalyticsRangeQuery, timeZone: string): AnalyticsWindows | null {
  if (!query.from || !query.to) return null;

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

export function resolveAnalyticsWindows(
  query: AnalyticsRangeQuery,
  timeZone: string,
  now = new Date(),
): AnalyticsWindows {
  const explicit = explicitWindows(query, timeZone);
  if (explicit) return explicit;

  const current = completedWindow(now, timeZone, query.days);
  return {
    current,
    comparison: completedWindow(now, timeZone, query.days, query.days),
    days: query.days,
  };
}

/**
 * Live first-party analytics should include the current store-local day. Pixel sessions are
 * materialized and rolled up continuously, so excluding today makes fresh observed activity look
 * like zero until the next day. Historical commerce workspaces keep using completed-day windows.
 */
export function resolveLiveAnalyticsWindows(
  query: AnalyticsRangeQuery,
  timeZone: string,
  now = new Date(),
): AnalyticsWindows {
  const explicit = explicitWindows(query, timeZone);
  if (explicit) return explicit;

  const toDate = storeDate(now, timeZone);
  const fromDate = addDateDays(toDate, -(query.days - 1));
  const current = dateWindow(fromDate, toDate, timeZone);
  const comparisonTo = addDateDays(fromDate, -1);
  const comparisonFrom = addDateDays(comparisonTo, -(query.days - 1));

  return {
    current,
    comparison: dateWindow(comparisonFrom, comparisonTo, timeZone),
    days: query.days,
  };
}
