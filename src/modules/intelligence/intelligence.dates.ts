interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface HistoricalDateWindow {
  fromDate: string;
  toDate: string;
  metaFrom: Date;
  metaTo: Date;
  instantFrom: Date;
  instantTo: Date;
}

function partsAt(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get('year')!,
    month: values.get('month')!,
    day: values.get('day')!,
    hour: values.get('hour')!,
    minute: values.get('minute')!,
    second: values.get('second')!,
  };
}

function isoDate(parts: Pick<DateParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

export function addDateDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function offsetAt(date: Date, timeZone: string): number {
  const parts = partsAt(date, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - date.getTime();
}

export function startOfStoreDate(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const naiveUtc = new Date(Date.UTC(year!, month! - 1, day!));
  let offset = offsetAt(naiveUtc, timeZone);
  let result = new Date(naiveUtc.getTime() - offset);

  const correctedOffset = offsetAt(result, timeZone);
  if (correctedOffset !== offset) {
    offset = correctedOffset;
    result = new Date(naiveUtc.getTime() - offset);
  }
  return result;
}

function metaDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function storeDate(date: Date, timeZone: string): string {
  return isoDate(partsAt(date, timeZone));
}

export function dateWindow(fromDate: string, toDate: string, timeZone: string): HistoricalDateWindow {
  return {
    fromDate,
    toDate,
    metaFrom: metaDate(fromDate),
    metaTo: metaDate(toDate),
    instantFrom: startOfStoreDate(fromDate, timeZone),
    instantTo: new Date(startOfStoreDate(addDateDays(toDate, 1), timeZone).getTime() - 1),
  };
}

export function completedWindow(
  now: Date,
  timeZone: string,
  days: number,
  offsetDays = 0,
): HistoricalDateWindow {
  const today = storeDate(now, timeZone);
  const toDate = addDateDays(today, -1 - offsetDays);
  const fromDate = addDateDays(toDate, -(days - 1));
  return dateWindow(fromDate, toDate, timeZone);
}
