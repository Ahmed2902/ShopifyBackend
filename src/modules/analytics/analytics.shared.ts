import type { HistoricalDateWindow } from '../intelligence/intelligence.dates.js';
import type { AnalyticsRepository } from './analytics.repository.js';

type MetaRow = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>[number];
type OrderRow = Awaited<ReturnType<AnalyticsRepository['getOrders']>>[number];
type CommerceRow = Awaited<ReturnType<AnalyticsRepository['getCommerceRows']>>[number];

export interface AnalyticsWindows {
  current: HistoricalDateWindow;
  comparison: HistoricalDateWindow;
  days: number;
}

export function inRange(value: Date, from: Date, to: Date): boolean {
  return value >= from && value <= to;
}

export function windowResponse(windows: AnalyticsWindows) {
  return {
    days: windows.days,
    current: { from: windows.current.fromDate, to: windows.current.toDate },
    comparison: { from: windows.comparison.fromDate, to: windows.comparison.toDate },
  };
}

export function pagination(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

export function splitMeta(rows: MetaRow[], windows: AnalyticsWindows) {
  return {
    current: rows.filter((row) => inRange(row.date, windows.current.metaFrom, windows.current.metaTo)),
    comparison: rows.filter((row) =>
      inRange(row.date, windows.comparison.metaFrom, windows.comparison.metaTo),
    ),
  };
}

export function splitOrders(
  rows: OrderRow[],
  windows: AnalyticsWindows,
  rowDate: (row: OrderRow) => Date,
) {
  return {
    current: rows.filter((row) =>
      inRange(rowDate(row), windows.current.instantFrom, windows.current.instantTo),
    ),
    comparison: rows.filter((row) =>
      inRange(rowDate(row), windows.comparison.instantFrom, windows.comparison.instantTo),
    ),
  };
}

export function splitCommerce(
  rows: CommerceRow[],
  windows: AnalyticsWindows,
  rowDate: (row: CommerceRow) => Date,
) {
  return {
    current: rows.filter((row) =>
      inRange(rowDate(row), windows.current.instantFrom, windows.current.instantTo),
    ),
    comparison: rows.filter((row) =>
      inRange(rowDate(row), windows.comparison.instantFrom, windows.comparison.instantTo),
    ),
  };
}

export function groupMetaByCurrency(rows: MetaRow[]): Map<string, MetaRow[]> {
  const groups = new Map<string, MetaRow[]>();
  for (const row of rows) {
    const group = groups.get(row.accountCurrency) ?? [];
    group.push(row);
    groups.set(row.accountCurrency, group);
  }
  return groups;
}
