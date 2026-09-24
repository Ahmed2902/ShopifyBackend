import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export type UnifiedAdvertisingProvider = 'META' | 'TIKTOK' | 'GOOGLE_ADS';
export type UnifiedAdvertisingPeriod = 'CURRENT' | 'COMPARISON';

export interface UnifiedProviderConnectionState {
  provider: UnifiedAdvertisingProvider;
  status: string | null;
  selectedExternalIds: string[];
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
}

export interface UnifiedAdvertisingAccountRow {
  id: string;
  provider: UnifiedAdvertisingProvider;
  providerEntityId: string;
  name: string;
  status: string | null;
  currency: string | null;
  timezone: string | null;
  lastSyncedAt: Date | null;
}

export interface UnifiedAdvertisingMetricRow {
  period: UnifiedAdvertisingPeriod;
  accountId: string;
  currency: string | null;
  sourceRows: number;
  conversionRows: number;
  conversionValueRows: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number | null;
  conversionValue: number | null;
  latestSyncedAt: Date | null;
}

function decimal(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class UnifiedAdvertisingRepository {
  async connectionStates(storeId: string): Promise<UnifiedProviderConnectionState[]> {
    const [meta, tiktok, google] = await Promise.all([
      prisma.metaConnection.findUnique({
        where: { storeId },
        select: { id: true, status: true, selectedAdAccountIds: true, lastSyncedAt: true },
      }),
      prisma.tikTokConnection.findUnique({
        where: { storeId },
        select: { id: true, status: true, selectedAdvertiserIds: true, lastSyncedAt: true },
      }),
      prisma.googleAdsConnection.findUnique({
        where: { storeId },
        select: {
          status: true,
          selectedCustomerIds: true,
          lastSyncedAt: true,
          lastSyncStatus: true,
        },
      }),
    ]);

    const [latestMetaRun, latestTikTokRun] = await Promise.all([
      meta
        ? prisma.syncRun.findFirst({
            where: { provider: 'META', metaConnectionId: meta.id },
            select: { status: true },
            orderBy: { createdAt: 'desc' },
          })
        : null,
      tiktok
        ? prisma.syncRun.findFirst({
            where: { provider: 'TIKTOK', tiktokConnectionId: tiktok.id },
            select: { status: true },
            orderBy: { createdAt: 'desc' },
          })
        : null,
    ]);

    return [
      {
        provider: 'META',
        status: meta?.status ?? null,
        selectedExternalIds: meta?.selectedAdAccountIds ?? [],
        lastSyncedAt: meta?.lastSyncedAt ?? null,
        lastSyncStatus: latestMetaRun?.status ?? null,
      },
      {
        provider: 'TIKTOK',
        status: tiktok?.status ?? null,
        selectedExternalIds: tiktok?.selectedAdvertiserIds ?? [],
        lastSyncedAt: tiktok?.lastSyncedAt ?? null,
        lastSyncStatus: latestTikTokRun?.status ?? null,
      },
      {
        provider: 'GOOGLE_ADS',
        status: google?.status ?? null,
        selectedExternalIds: google?.selectedCustomerIds ?? [],
        lastSyncedAt: google?.lastSyncedAt ?? null,
        lastSyncStatus: google?.lastSyncStatus ?? null,
      },
    ];
  }

  async selectedAccounts(
    storeId: string,
    states: UnifiedProviderConnectionState[],
  ): Promise<UnifiedAdvertisingAccountRow[]> {
    const providerFilters = states
      .filter((state) => state.selectedExternalIds.length > 0)
      .map((state) => ({
        provider: state.provider,
        providerEntityId: { in: state.selectedExternalIds },
      }));
    if (providerFilters.length === 0) return [];

    return prisma.advertisingAccount.findMany({
      where: { storeId, OR: providerFilters },
      select: {
        id: true,
        provider: true,
        providerEntityId: true,
        name: true,
        status: true,
        currency: true,
        timezone: true,
        lastSyncedAt: true,
      },
      orderBy: [{ provider: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    }) as Promise<UnifiedAdvertisingAccountRow[]>;
  }

  async metricRows(input: {
    accounts: UnifiedAdvertisingAccountRow[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<UnifiedAdvertisingMetricRow[]> {
    const periods: Array<{
      period: UnifiedAdvertisingPeriod;
      from: Date;
      to: Date;
    }> = [
      { period: 'CURRENT', from: input.currentFrom, to: input.currentTo },
      { period: 'COMPARISON', from: input.comparisonFrom, to: input.comparisonTo },
    ];
    const providers: UnifiedAdvertisingProvider[] = ['META', 'TIKTOK', 'GOOGLE_ADS'];
    const rows = await Promise.all(
      periods.flatMap(({ period, from, to }) =>
        providers.map(async (provider) => {
          const accountIds = input.accounts
            .filter((account) => account.provider === provider)
            .map((account) => account.id);
          if (accountIds.length === 0) return [] as UnifiedAdvertisingMetricRow[];

          // Meta/TikTok canonical reads are normalized at AD level. Google also writes ACCOUNT
          // facts because Performance Max can truthfully have no ad entity. Reading one level per
          // provider avoids double-counting the same provider fact at multiple hierarchy levels.
          const level = provider === 'GOOGLE_ADS' ? 'ACCOUNT' : 'AD';
          const grouped = await prisma.advertisingDailyMetric.groupBy({
            by: ['accountId', 'currency'],
            where: {
              accountId: { in: accountIds },
              level,
              date: { gte: from, lte: to },
            },
            _count: { _all: true, conversions: true, conversionValue: true },
            _sum: {
              spend: true,
              impressions: true,
              clicks: true,
              conversions: true,
              conversionValue: true,
            },
            _max: { syncedAt: true },
          });

          // Prisma SUM ignores nulls. If one account has only partial attribution coverage, a
          // provider/currency total must not silently look complete. Conservatively fail that
          // provider/currency metric closed while keeping spend/delivery evidence available.
          const incompleteConversionCurrencies = new Set(
            grouped
              .filter((row) => row._count.conversions !== row._count._all)
              .map((row) => row.currency),
          );
          const incompleteValueCurrencies = new Set(
            grouped
              .filter((row) => row._count.conversionValue !== row._count._all)
              .map((row) => row.currency),
          );

          return grouped.map((row) => ({
            period,
            accountId: row.accountId,
            currency: row.currency,
            sourceRows: row._count._all,
            conversionRows: row._count.conversions,
            conversionValueRows: row._count.conversionValue,
            spend: decimal(row._sum.spend) ?? 0,
            impressions: integer(row._sum.impressions),
            clicks: integer(row._sum.clicks),
            conversions: incompleteConversionCurrencies.has(row.currency)
              ? null
              : decimal(row._sum.conversions),
            conversionValue: incompleteValueCurrencies.has(row.currency)
              ? null
              : decimal(row._sum.conversionValue),
            latestSyncedAt: row._max.syncedAt,
          }));
        }),
      ),
    );
    return rows.flat();
  }

  async entityCounts(accountIds: string[]) {
    if (accountIds.length === 0) {
      return { campaigns: 0, groups: 0, ads: 0, creatives: 0 };
    }
    const [campaigns, groups, ads, creatives] = await Promise.all([
      prisma.advertisingCampaign.count({
        where: { accountId: { in: accountIds }, deletedAt: null },
      }),
      prisma.advertisingGroup.count({
        where: { accountId: { in: accountIds }, deletedAt: null },
      }),
      prisma.advertisingAd.count({
        where: { accountId: { in: accountIds }, deletedAt: null },
      }),
      prisma.advertisingCreative.count({
        where: { accountId: { in: accountIds }, deletedAt: null },
      }),
    ]);
    return { campaigns, groups, ads, creatives };
  }
}
