import type { AdvertisingProvider, Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/app-error.js';

export type CanonicalPaidMediaLevel = 'CAMPAIGN' | 'GROUP' | 'AD';

type CanonicalAccount = {
  id: string;
  providerEntityId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  status: string | null;
};

type MetricAggregate = {
  currency: string | null;
  spend: string;
  impressions: string;
  reach: string | null;
  clicks: string;
  conversions: string | null;
  conversionValue: string | null;
};

function decimal(value: Prisma.Decimal | null | undefined): string | null {
  return value == null ? null : value.toString();
}

function integer(value: bigint | null | undefined): string | null {
  return value == null ? null : value.toString();
}

function dateWindow(days: number) {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - Math.max(days - 1, 0));
  return { from, to };
}

function aggregateRow(row: {
  currency: string | null;
  _sum: {
    spend: Prisma.Decimal | null;
    impressions: bigint | null;
    reach: bigint | null;
    clicks: bigint | null;
    conversions: Prisma.Decimal | null;
    conversionValue: Prisma.Decimal | null;
  };
}): MetricAggregate {
  return {
    currency: row.currency,
    spend: decimal(row._sum.spend) ?? '0',
    impressions: integer(row._sum.impressions) ?? '0',
    reach: integer(row._sum.reach),
    clicks: integer(row._sum.clicks) ?? '0',
    conversions: decimal(row._sum.conversions),
    conversionValue: decimal(row._sum.conversionValue),
  };
}

/**
 * Canonical runtime reader used above provider ingestion.
 *
 * Selection is supplied as provider account external IDs because merchant selection remains an
 * integration concern. An optional accountId is a canonical AdvertisingAccount UUID and is
 * validated against store, provider and the merchant-selected external IDs before any hierarchy
 * or metric query is executed.
 */
export class CanonicalPaidMediaReadService {
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

  async overview(input: {
    storeId: string;
    provider: AdvertisingProvider;
    selectedAccountExternalIds: string[];
    accountId?: string;
    days: number;
  }) {
    const accounts = await this.accounts(input);
    const accountIds = accounts.map((account) => account.id);
    const window = dateWindow(input.days);
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
          level: 'AD',
          date: { gte: window.from, lte: window.to },
        },
        _sum: {
          spend: true,
          impressions: true,
          reach: true,
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
    const accounts = await this.accounts(input);
    const accountIds = accounts.map((account) => account.id);
    const window = dateWindow(input.days);
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
      const metrics = await this.campaignMetrics(accountIds, items.map((item) => item.id), window);
      return { accounts, window, items: items.map((item) => ({ ...item, metrics: metrics.get(item.id) ?? [] })), page: input.page, limit: input.limit, total };
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
      const metrics = await this.groupMetrics(accountIds, items.map((item) => item.id), window);
      return { accounts, window, items: items.map((item) => ({ ...item, metrics: metrics.get(item.id) ?? [] })), page: input.page, limit: input.limit, total };
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
    return { accounts, window, items: items.map((item) => ({ ...item, metrics: metrics.get(item.id) ?? [] })), page: input.page, limit: input.limit, total };
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
    const accounts = await this.accounts(input);
    const accountIds = accounts.map((account) => account.id);
    const window = dateWindow(input.days);
    if (accountIds.length === 0) return { accounts: [], window, item: null };

    if (input.level === 'CAMPAIGN') {
      const item = await prisma.advertisingCampaign.findFirst({
        where: { accountId: { in: accountIds }, deletedAt: null, OR: [{ id: input.entityId }, { providerEntityId: input.entityId }] },
      });
      const metrics = item ? await this.campaignMetrics(accountIds, [item.id], window) : new Map();
      return { accounts, window, item: item ? { ...item, metrics: metrics.get(item.id) ?? [] } : null };
    }
    if (input.level === 'GROUP') {
      const item = await prisma.advertisingGroup.findFirst({
        where: { accountId: { in: accountIds }, deletedAt: null, OR: [{ id: input.entityId }, { providerEntityId: input.entityId }] },
      });
      const metrics = item ? await this.groupMetrics(accountIds, [item.id], window) : new Map();
      return { accounts, window, item: item ? { ...item, metrics: metrics.get(item.id) ?? [] } : null };
    }
    const item = await prisma.advertisingAd.findFirst({
      where: { accountId: { in: accountIds }, deletedAt: null, OR: [{ id: input.entityId }, { providerEntityId: input.entityId }] },
    });
    const metrics = item ? await this.adMetrics(accountIds, [item.id], window) : new Map();
    return { accounts, window, item: item ? { ...item, metrics: metrics.get(item.id) ?? [] } : null };
  }

  private async campaignMetrics(accountIds: string[], ids: string[], window: { from: Date; to: Date }) {
    if (ids.length === 0) return new Map<string, MetricAggregate[]>();
    const rows = await prisma.advertisingDailyMetric.groupBy({
      by: ['campaignId', 'currency'],
      where: { accountId: { in: accountIds }, level: 'AD', campaignId: { in: ids }, date: { gte: window.from, lte: window.to } },
      _sum: { spend: true, impressions: true, reach: true, clicks: true, conversions: true, conversionValue: true },
    });
    return this.groupMetricsById(rows.map((row) => ({ id: row.campaignId, metric: aggregateRow(row) })));
  }

  private async groupMetrics(accountIds: string[], ids: string[], window: { from: Date; to: Date }) {
    if (ids.length === 0) return new Map<string, MetricAggregate[]>();
    const rows = await prisma.advertisingDailyMetric.groupBy({
      by: ['groupId', 'currency'],
      where: { accountId: { in: accountIds }, level: 'AD', groupId: { in: ids }, date: { gte: window.from, lte: window.to } },
      _sum: { spend: true, impressions: true, reach: true, clicks: true, conversions: true, conversionValue: true },
    });
    return this.groupMetricsById(rows.map((row) => ({ id: row.groupId, metric: aggregateRow(row) })));
  }

  private async adMetrics(accountIds: string[], ids: string[], window: { from: Date; to: Date }) {
    if (ids.length === 0) return new Map<string, MetricAggregate[]>();
    const rows = await prisma.advertisingDailyMetric.groupBy({
      by: ['adId', 'currency'],
      where: { accountId: { in: accountIds }, level: 'AD', adId: { in: ids }, date: { gte: window.from, lte: window.to } },
      _sum: { spend: true, impressions: true, reach: true, clicks: true, conversions: true, conversionValue: true },
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
