import { storeDate } from '../intelligence/intelligence.dates.js';
import type { AdvertisingAnalyticsRepository } from './advertising-analytics.repository.js';
import { aggregateMeta, aggregateOrders, orderDate } from './analytics.metrics.js';
import type { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsWindows } from './analytics.shared.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;
type OrderRow = Awaited<ReturnType<AnalyticsRepository['getOrders']>>[number];
type MetaRow = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>[number];

function dateKeys(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function groupOrders(rows: OrderRow[], timeZone: string): Map<string, OrderRow[]> {
  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const date = storeDate(orderDate(row), timeZone);
    const values = groups.get(date) ?? [];
    values.push(row);
    groups.set(date, values);
  }
  return groups;
}

function groupMeta(rows: MetaRow[]): Map<string, MetaRow[]> {
  const groups = new Map<string, MetaRow[]>();
  for (const row of rows) {
    // Advertising `date` is already the provider reporting-date value. Keep that calendar date
    // intact rather than pretending it is an instant in the merchant timezone.
    const date = row.date.toISOString().slice(0, 10);
    const values = groups.get(date) ?? [];
    values.push(row);
    groups.set(date, values);
  }
  return groups;
}

function blendedMer(netOrderValue: number, spend: number): number | null {
  return spend > 0 ? netOrderValue / spend : null;
}

export class OverviewTrendService {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly advertisingRepository: AdvertisingAnalyticsRepository = repository,
  ) {}

  async current(store: StoreContext, windows: AnalyticsWindows) {
    const selectedAccounts = store.metaConnection?.selectedAdAccountIds ?? [];
    const [orders, metaRows] = await Promise.all([
      this.repository.getOrders(store.id, windows.current.instantFrom, windows.current.instantTo),
      this.advertisingRepository.getMetaRows(
        store.id,
        selectedAccounts,
        windows.current.metaFrom,
        windows.current.metaTo,
      ),
    ]);

    // A performance series has a single currency axis, so every advertising metric exposed by this
    // resource is explicitly scoped to provider rows that use the Shopify store currency. Other
    // currencies are reported as exclusions instead of being silently converted or mixed.
    const storeCurrencyMetaRows = metaRows.filter((row) => row.accountCurrency === store.currencyCode);
    const excludedMetaCurrencies = [
      ...new Set(
        metaRows
          .map((row) => row.accountCurrency)
          .filter((currency) => currency !== store.currencyCode),
      ),
    ].sort();
    const commerceByDate = groupOrders(orders, store.ianaTimezone);
    const metaByDate = groupMeta(storeCurrencyMetaRows);
    const summaryCommerce = aggregateOrders(orders, store.currencyCode);
    const summaryAdvertising = aggregateMeta(storeCurrencyMetaRows);

    return {
      granularity: 'DAY' as const,
      currency: store.currencyCode,
      advertisingCurrencyScope: 'STORE_CURRENCY_ONLY' as const,
      excludedMetaCurrencies,
      alignment: 'SHOPIFY_MERCHANT_LOCAL_DATE_WITH_META_PROVIDER_REPORT_DATE' as const,
      summary: {
        commerce: summaryCommerce,
        advertising: summaryAdvertising,
        blended: {
          mer: blendedMer(summaryCommerce.netOrderValue, summaryAdvertising.spend),
        },
      },
      points: dateKeys(windows.current.fromDate, windows.current.toDate).map((date) => {
        const commerce = aggregateOrders(commerceByDate.get(date) ?? [], store.currencyCode);
        const advertising = aggregateMeta(metaByDate.get(date) ?? []);
        return {
          date,
          commerce,
          advertising,
          blended: {
            mer: blendedMer(commerce.netOrderValue, advertising.spend),
          },
        };
      }),
    };
  }
}
