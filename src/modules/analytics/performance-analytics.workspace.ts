import { AppError } from '../../errors/app-error.js';
import { memoizeRequestRead } from '../../lib/request-read-cache.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';
import { OverviewTrendService } from './overview-trend.service.js';

export class PerformanceAnalyticsWorkspace {
  private readonly trend: OverviewTrendService;

  constructor(private readonly repository: AnalyticsRepository = new AnalyticsRepository()) {
    this.trend = new OverviewTrendService(repository);
  }

  async daily(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    // Shopify commerce in this read is store-scoped. Comparing it with one selected Meta account
    // would make the cross-channel MER/trend look account-specific when the commerce numerator is
    // still the whole store, so fail closed instead of silently ignoring `accountId` or fabricating
    // an account-attributed commerce series.
    if (query.accountId) {
      throw new AppError(
        'Account-scoped cross-channel performance is not supported because Shopify commerce remains store-scoped',
        400,
        'ACCOUNT_SCOPED_PERFORMANCE_UNSUPPORTED',
      );
    }

    const store = await memoizeRequestRead(`analytics:store-context:${storeId}`, () =>
      this.repository.getStoreContext(storeId),
    );
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const trend = await this.trend.current(store, windows);

    return {
      window: windowResponse(windows),
      methodology: {
        commerceDate: 'SHOPIFY_ORDER_DATE_IN_MERCHANT_TIMEZONE',
        advertisingDate: 'META_PROVIDER_REPORT_DATE',
        currency: 'PERFORMANCE_ADVERTISING_FILTERED_TO_STORE_CURRENCY',
        mer: 'SHOPIFY_CURRENT_ORDER_VALUE_DIVIDED_BY_SAME_CURRENCY_META_SPEND',
      },
      ...trend,
    };
  }
}

export const performanceAnalyticsWorkspace = new PerformanceAnalyticsWorkspace();
