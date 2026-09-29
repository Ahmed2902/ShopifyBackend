import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { unifiedAdvertisingScopeService } from '../advertising/unified-advertising-scope.service.js';
import type { UnifiedAdvertisingRangeQuery } from '../advertising/unified-advertising.schema.js';
import type { UnifiedAdvertisingProvider } from '../advertising/unified-advertising.repository.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { windowResponse } from './analytics.shared.js';

function bucketDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type DailyPoint = {
  date: string;
  currency: string;
  spend: number;
  purchaseValue: number | null;
  purchases: number | null;
  impressions: number;
  clicks: number;
};

export class AdvertisingDailyReadService {
  async read(storeId: string, query: UnifiedAdvertisingRangeQuery, now = new Date()) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { ianaTimezone: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const scope = await unifiedAdvertisingScopeService.resolve({
      storeId,
      provider: query.provider,
      accountId: query.accountId,
      currency: query.currency,
    });
    const grouped = new Map<string, DailyPoint>();

    const providers: UnifiedAdvertisingProvider[] = ['META', 'TIKTOK', 'GOOGLE_ADS'];
    for (const provider of providers) {
      const accounts = scope.accounts.filter((account) => account.provider === provider);
      if (accounts.length === 0) continue;
      const rows = await prisma.advertisingDailyMetric.groupBy({
        by: ['date', 'currency'],
        where: {
          accountId: { in: accounts.map((account) => account.id) },
          level: provider === 'GOOGLE_ADS' ? 'ACCOUNT' : 'AD',
          date: {
            gte: bucketDate(windows.current.fromDate),
            lte: bucketDate(windows.current.toDate),
          },
          ...(query.currency ? { currency: query.currency } : {}),
        },
        _sum: {
          spend: true,
          conversionValue: true,
          conversions: true,
          impressions: true,
          clicks: true,
        },
        _count: {
          _all: true,
          conversionValue: true,
          conversions: true,
        },
        orderBy: [{ date: 'asc' }, { currency: 'asc' }],
      });

      for (const row of rows) {
        const accountCurrencies = [...new Set(
          accounts
            .map((account) => account.currency)
            .filter((value): value is string => Boolean(value)),
        )];
        const currency = row.currency ?? query.currency ?? (accountCurrencies.length === 1 ? accountCurrencies[0]! : 'UNKNOWN');
        const date = row.date.toISOString().slice(0, 10);
        const key = `${date}:${currency}`;
        const point = grouped.get(key) ?? {
          date,
          currency,
          spend: 0,
          purchaseValue: 0,
          purchases: 0,
          impressions: 0,
          clicks: 0,
        };

        point.spend += numeric(row._sum.spend);
        point.impressions += numeric(row._sum.impressions);
        point.clicks += numeric(row._sum.clicks);

        if (point.purchaseValue !== null) {
          point.purchaseValue = row._count.conversionValue === row._count._all
            ? point.purchaseValue + numeric(row._sum.conversionValue)
            : null;
        }
        if (point.purchases !== null) {
          point.purchases = row._count.conversions === row._count._all
            ? point.purchases + numeric(row._sum.conversions)
            : null;
        }

        grouped.set(key, point);
      }
    }

    return {
      window: windowResponse(windows),
      provider: query.provider,
      accounts: scope.accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        providerEntityId: account.providerEntityId,
        name: account.name,
        currency: account.currency,
      })),
      points: [...grouped.values()].sort((left, right) => left.date.localeCompare(right.date) || left.currency.localeCompare(right.currency)),
      methodology: 'CANONICAL_PROVIDER_DAILY_FACTS_NO_CURRENCY_CONVERSION',
    };
  }
}

export const advertisingDailyReadService = new AdvertisingDailyReadService();
