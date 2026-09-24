import type { AdvertisingGroupKind, AdvertisingProvider, Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { resolveAnalyticsWindows } from '../analytics/analytics.dates.js';

export type CanonicalPaidMediaLevel = 'CAMPAIGN' | 'GROUP' | 'AD';

type CanonicalAccount = {
  id: string;
  providerEntityId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  status: string | null;
};

type ReportingWindow = {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  timeZone: string;
};

type MetricAggregate = {
  currency: string | null;
  evidenceAvailable: true;
  sourceRows: number;
  spend: string;
  impressions: string;
  reach: null;
  clicks: string;
  conversions: string | null;
  conversionValue: string | null;
  conversionsAvailable: boolean;
  conversionValueAvailable: boolean;
};

type GroupIdentity = { id: string; kind: AdvertisingGroupKind };

type AggregateGroupRow = {
  currency: string | null;
  _count: { _all: number; conversions: number; conversionValue: number };
  _sum: {
    spend: Prisma.Decimal | null;
    impressions: bigint | null;
    clicks: bigint | null;
    conversions: Prisma.Decimal | null;
    conversionValue: Prisma.Decimal | null;
  };
};

function decimal(value: Prisma.Decimal | null | undefined): string | null {
  return value == null ? null : value.toString();
}

function integer(value: bigint | null | undefined): string | null {
  return value == null ? null : value.toString();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function aggregateRow(row: AggregateGroupRow): MetricAggregate {
  const conversionsAvailable = row._count.conversions === row._count._all;
  const conversionValueAvailable = row._count.conversionValue === row._count._all;
  return {
    currency: row.currency,
    evidenceAvailable: true,
    sourceRows: row._count._all,
    spend: decimal(row._sum.spend) ?? '0',
    impressions: integer(row._sum.impressions) ?? '0',
    // Reach is non-additive across dates and entities. Canonical daily facts cannot truthfully
    // produce a deduplicated period reach, so keep it unavailable instead of summing daily reach.
    reach: null,
    clicks: integer(row._sum.clicks) ?? '0',
    conversions: conversionsAvailable ? decimal(row._sum.conversions) : null,
    conversionValue: conversionValueAvailable ? decimal(row._sum.conversionValue) : null,
    conversionsAvailable,
    conversionValueAvailable,
  };
}

/**
 * Provider-neutral metric-source policy.
 *
 * Meta/TikTok canonical production reads derive hierarchy totals from AD facts because that is the
 * completed canonical runtime contract for those providers. Google persists trustworthy facts at
 * each hierarchy level; ACCOUNT/CAMPAIGN/GROUP/ASSET_GROUP/AD must therefore be read from their own
 * level so Performance Max Asset Groups work without invented AdvertisingAd rows and hierarchy facts
 * are never summed together.
 */
function overviewMetricLevel(provider: AdvertisingProvider) {
  return provider === 'GOOGLE_ADS' ? ('ACCOUNT' as const) : ('AD' as const);
}

function campaignMetricLevel(provider: AdvertisingProvider) {
  return provider === 'GOOGLE_ADS' ? ('CAMPAIGN' as const) : ('AD' as const);
}

export function canonicalPaidMediaReportingWindow(
  days: number,
  timeZone: string,
  now = new Date(),
): ReportingWindow {
  const windows = resolveAnalyticsWindows({ days }, timeZone, now);
  return {
    from: windows.current.metaFrom,
    to: windows.current.metaTo,
    fromDate: windows.current.fromDate,
    toDate: windows.current.toDate,
    timeZone,
  };
}

/**
 * Canonical runtime reader used above provider ingestion.
 *
 * Selection is supplied as provider account external IDs because merchant selection remains an
 * integration concern. An optional accountId is a canonical AdvertisingAccount UUID and is
 * validated against store, provider and the merchant-selected external IDs before any hierarchy
 * or metric query is executed.
 *
 * Reporting windows use the store/business timezone and completed local days, matching unified
 * analytics. Provider ingestion may use provider/account timezone to request source facts, but once
 * persisted as canonical DATE facts the user-visible comparison window is the merchant reporting
 * calendar.
 */
export class CanonicalPaidMediaReadService {
  constructor(private readonly now: () => Date = () => new Date()) {}

  private async accounts(input: {
    storeId: string;
    provider: AdvertisingProvider;
    selectedAccountExternalIds: string[];
    accountId?: string;
  }): Promise<CanonicalAccount[]> {
    if (input.selectedAccountExternalIds.length === 0) return [];

    const accounts = await prisma.advertisingAccount.findMany({
      where: {
        storeId: input.storeId,
        provider: input.provider,
        providerEntityId: { in: input.selectedAccountExternalIds },
        ...(input.accountId ? { id: input.accountId } : {}),
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        currency: true,
        timezone: true,
        status: true,
      },
      orderBy: [{ name: 'asc' }, { providerEntityId: 'asc' }],
    });

    if (input.accountId && accounts.length === 0) {
      throw new AppError(
        'Advertising account is not selected for this store and provider',
        400,
        'ADVERTISING_ACCOUNT_NOT_SELECTED',
      );
    }
    return accounts;
  }

  private async window(storeId: string, days: number): Promise<ReportingWindow> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { ianaTimezone: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return canonicalPaidMediaReportingWindow(days, store.ianaTimezone, this.now());
  }

  async overview(input: {
    storeId: string;
    provider: AdvertisingProvider;
    selectedAccountExternalIds: string[];
    accountId?: string;
    days: number;
  }) {
    const [accounts, window] = await Promise.all([
      this.accounts(input),
      this.window(input.storeId, input.days),
    ]);
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length === 0) {
      return {
        accounts: [],
        window,
        counts: { campaigns: 0, groups: 0, ads: 0 },
        metrics: [] as MetricAggregate[],
      };
    }

    const [campaigns, groups, ads, metrics] = await Promise.all([
      prisma.advertisingCampaign.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
      prisma.advertisingGroup.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
      prisma.advertisingAd.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
      prisma.advertisingDailyMetric.groupBy({
        by: ['currency'],
        where: {
          accountId: { in: accountIds },
          level: overviewMetricLevel(input.provider),
          date: { gte: window.from, lte: window.to },
        },
        _count: { _all: true, conversions: true, conversionValue: true },
        _sum: {
          spend: true,
          impressions: true,
          clicks: true,
          conversions: true,
          conversionValue: true,
        },
        orderBy: { currency: 'asc' },
      }),
    ]);

    return {
      accounts,
      window,
      counts: { campaigns, groups, ads },
      metrics: metrics.map(aggregateRow),
    };
  }

  async list(input: {
    storeId: string;
    provider: AdvertisingProvider;
    selectedAccountExternalIds: string[];
    accountId?: string;
    level: CanonicalPaidMediaLevel;
    days: number;
    page: number;
    limit: number;
  }) {
    const [accounts, window] = await Promise.all([
      this.accounts(input),
      this.window(input.storeId, input.days),
    ]);
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length === 0) {
      return { accounts: [], window, items: [], page: input.page, limit: input.limit, total: 0 };
    }

    const skip = (input.page - 1) * input.limit;
    if (input.level === 'CAMPAIGN') {
      const [items, total] = await Promise.all([
        prisma.advertisingCampaign.findMany({
          where: { accountId: { in: accountIds }, deletedAt: null },
          select: {
            id: true,
            accountId: true,
            providerEntityId: true,
            name: true,
            status: true,
            effectiveStatus: true,
            objective: true,
            campaignType: true,
            budgetAmount: true,
            budgetMode: true,
          },
          orderBy: [{ providerUpdatedAt: 'desc' }, { id: 'asc' }],
          skip,
          take: input.limit,
        }),
        prisma.advertisingCampaign.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
      ]);
      const metrics = await this.campaignMetrics(
        input.provider,
        accountIds,
        items.map((item) => item.id),
        window,
      );
      return {
        accounts,
        window,
        items: items.map((item) => ({ ...item, metrics: metrics.get(item.id) ?? [] })),
        page: input.page,
        limit: input.limit,
        total,
      };
    }

    if (input.level === 'GROUP') {
      const [items, total] = await Promise.all([
        prisma.advertisingGroup.findMany({
          where: { accountId: { in: accountIds }, deletedAt: null },
          select: {
            id: true,
            accountId: true,
            campaignId: true,
            providerEntityId: true,
            kind: true,
            name: true,
            status: true,
            effectiveStatus: true,
            optimizationGoal: true,
            budgetAmount: true,
            budgetMode: true,
          },
          orderBy: [{ providerUpdatedAt: 'desc' }, { id: 'asc' }],
          skip,
          take: input.limit,
        }),
        prisma.advertisingGroup.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
      ]);
      const metrics = await this.groupMetrics(input.provider, accountIds, items, window);
      return {
        accounts,
        window,
        items: items.map((item) => ({ ...item, metrics: metrics.get(item.id) ?? [] })),
        page: input.page,
        limit: input.limit,
        total,
      };
    }

    const [items, total] = await Promise.all([
      prisma.advertisingAd.findMany({
        where: { accountId: { in: accountIds }, deletedAt: null },
        select: {
          id: true,
          accountId: true,
          campaignId: true,
          groupId: true,
          providerEntityId: true,
          name: true,
          status: true,
          effectiveStatus: true,
          format: true,
          landingPageUrl: true,
          targetScope: true,
          targetScopeConfidence: true,
        },
        orderBy: [{ providerUpdatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take: input.limit,
      }),
      prisma.advertisingAd.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
    ]);
    const metrics = await this.adMetrics(accountIds, items.map((item) => item.id), window);
    return {
      accounts,
      window,
      items: items.map((item) => ({ ...item, metrics: metrics.get(item.id) ?? [] })),
      page: input.page,
      limit: input.limit,
      total,
    };
  }

  async detail(input: {
    storeId: string;
    provider: AdvertisingProvider;
    selectedAccountExternalIds: string[];
    accountId?: string;
    level: CanonicalPaidMediaLevel;
    entityId: string;
    days: number;
  }) {
    const [accounts, window] = await Promise.all([
      this.accounts(input),
      this.window(input.storeId, input.days),
    ]);
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length === 0) return { accounts: [], window, item: null };

    if (input.level === 'CAMPAIGN') {
      const item = await this.campaignByIdentifier(accountIds, input.entityId);
      const metrics = item
        ? await this.campaignMetrics(input.provider, accountIds, [item.id], window)
        : new Map<string, MetricAggregate[]>();
      return {
        accounts,
        window,
        item: item ? { ...item, metrics: metrics.get(item.id) ?? [] } : null,
      };
    }
    if (input.level === 'GROUP') {
      const item = await this.groupByIdentifier(accountIds, input.entityId);
      const metrics = item
        ? await this.groupMetrics(input.provider, accountIds, [{ id: item.id, kind: item.kind }], window)
        : new Map<string, MetricAggregate[]>();
      return {
        accounts,
        window,
        item: item ? { ...item, metrics: metrics.get(item.id) ?? [] } : null,
      };
    }
    const item = await this.adByIdentifier(accountIds, input.entityId);
    const metrics = item
      ? await this.adMetrics(accountIds, [item.id], window)
      : new Map<string, MetricAggregate[]>();
    return {
      accounts,
      window,
      item: item ? { ...item, metrics: metrics.get(item.id) ?? [] } : null,
    };
  }

  private async campaignByIdentifier(accountIds: string[], entityId: string) {
    if (isUuid(entityId)) {
      const canonical = await prisma.advertisingCampaign.findFirst({
        where: { id: entityId, accountId: { in: accountIds }, deletedAt: null },
      });
      if (canonical) return canonical;
    }
    const candidates = await prisma.advertisingCampaign.findMany({
      where: { providerEntityId: entityId, accountId: { in: accountIds }, deletedAt: null },
      take: 2,
      orderBy: { id: 'asc' },
    });
    return this.singleExternalCandidate(candidates, entityId);
  }

  private async groupByIdentifier(accountIds: string[], entityId: string) {
    if (isUuid(entityId)) {
      const canonical = await prisma.advertisingGroup.findFirst({
        where: { id: entityId, accountId: { in: accountIds }, deletedAt: null },
      });
      if (canonical) return canonical;
    }
    const candidates = await prisma.advertisingGroup.findMany({
      where: { providerEntityId: entityId, accountId: { in: accountIds }, deletedAt: null },
      take: 2,
      orderBy: { id: 'asc' },
    });
    return this.singleExternalCandidate(candidates, entityId);
  }

  private async adByIdentifier(accountIds: string[], entityId: string) {
    if (isUuid(entityId)) {
      const canonical = await prisma.advertisingAd.findFirst({
        where: { id: entityId, accountId: { in: accountIds }, deletedAt: null },
      });
      if (canonical) return canonical;
    }
    const candidates = await prisma.advertisingAd.findMany({
      where: { providerEntityId: entityId, accountId: { in: accountIds }, deletedAt: null },
      take: 2,
      orderBy: { id: 'asc' },
    });
    return this.singleExternalCandidate(candidates, entityId);
  }

  private singleExternalCandidate<T>(candidates: T[], entityId: string): T | null {
    if (candidates.length > 1) {
      throw new AppError(
        'External advertising entity id is ambiguous across selected accounts; use the canonical entity UUID or scope the request to one canonical accountId.',
        409,
        'ADVERTISING_ENTITY_ID_AMBIGUOUS',
        { providerEntityId: entityId },
      );
    }
    return candidates[0] ?? null;
  }

  private async campaignMetrics(
    provider: AdvertisingProvider,
    accountIds: string[],
    ids: string[],
    window: ReportingWindow,
  ) {
    if (ids.length === 0) return new Map<string, MetricAggregate[]>();
    const rows = await prisma.advertisingDailyMetric.groupBy({
      by: ['campaignId', 'currency'],
      where: {
        accountId: { in: accountIds },
        level: campaignMetricLevel(provider),
        campaignId: { in: ids },
        date: { gte: window.from, lte: window.to },
      },
      _count: { _all: true, conversions: true, conversionValue: true },
      _sum: {
        spend: true,
        impressions: true,
        clicks: true,
        conversions: true,
        conversionValue: true,
      },
    });
    return this.groupMetricsById(
      rows.map((row) => ({ id: row.campaignId, metric: aggregateRow(row) })),
    );
  }

  private async groupMetrics(
    provider: AdvertisingProvider,
    accountIds: string[],
    groups: GroupIdentity[],
    window: ReportingWindow,
  ) {
    if (groups.length === 0) return new Map<string, MetricAggregate[]>();
    if (provider !== 'GOOGLE_ADS') {
      const ids = groups.map((group) => group.id);
      const rows = await prisma.advertisingDailyMetric.groupBy({
        by: ['groupId', 'currency'],
        where: {
          accountId: { in: accountIds },
          level: 'AD',
          groupId: { in: ids },
          date: { gte: window.from, lte: window.to },
        },
        _count: { _all: true, conversions: true, conversionValue: true },
        _sum: {
          spend: true,
          impressions: true,
          clicks: true,
          conversions: true,
          conversionValue: true,
        },
      });
      return this.groupMetricsById(
        rows.map((row) => ({ id: row.groupId, metric: aggregateRow(row) })),
      );
    }

    const ordinaryIds = groups
      .filter((group) => group.kind !== 'ASSET_GROUP')
      .map((group) => group.id);
    const assetGroupIds = groups
      .filter((group) => group.kind === 'ASSET_GROUP')
      .map((group) => group.id);
    const levelFilters: Prisma.AdvertisingDailyMetricWhereInput[] = [
      ...(ordinaryIds.length > 0 ? [{ level: 'GROUP' as const, groupId: { in: ordinaryIds } }] : []),
      ...(assetGroupIds.length > 0
        ? [{ level: 'ASSET_GROUP' as const, groupId: { in: assetGroupIds } }]
        : []),
    ];
    if (levelFilters.length === 0) return new Map<string, MetricAggregate[]>();
    const rows = await prisma.advertisingDailyMetric.groupBy({
      by: ['groupId', 'currency'],
      where: {
        accountId: { in: accountIds },
        OR: levelFilters,
        date: { gte: window.from, lte: window.to },
      },
      _count: { _all: true, conversions: true, conversionValue: true },
      _sum: {
        spend: true,
        impressions: true,
        clicks: true,
        conversions: true,
        conversionValue: true,
      },
    });
    return this.groupMetricsById(
      rows.map((row) => ({ id: row.groupId, metric: aggregateRow(row) })),
    );
  }

  private async adMetrics(accountIds: string[], ids: string[], window: ReportingWindow) {
    if (ids.length === 0) return new Map<string, MetricAggregate[]>();
    const rows = await prisma.advertisingDailyMetric.groupBy({
      by: ['adId', 'currency'],
      where: {
        accountId: { in: accountIds },
        level: 'AD',
        adId: { in: ids },
        date: { gte: window.from, lte: window.to },
      },
      _count: { _all: true, conversions: true, conversionValue: true },
      _sum: {
        spend: true,
        impressions: true,
        clicks: true,
        conversions: true,
        conversionValue: true,
      },
    });
    return this.groupMetricsById(rows.map((row) => ({ id: row.adId, metric: aggregateRow(row) })));
  }

  private groupMetricsById(rows: Array<{ id: string | null; metric: MetricAggregate }>) {
    const result = new Map<string, MetricAggregate[]>();
    for (const row of rows) {
      if (!row.id) continue;
      const bucket = result.get(row.id) ?? [];
      bucket.push(row.metric);
      result.set(row.id, bucket);
    }
    return result;
  }
}

export const canonicalPaidMediaReadService = new CanonicalPaidMediaReadService();
