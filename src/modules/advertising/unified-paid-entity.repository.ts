import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type {
  UnifiedAdvertisingAccountRow,
  UnifiedAdvertisingPeriod,
  UnifiedAdvertisingProvider,
} from './unified-advertising.repository.js';

export type UnifiedPaidEntityKind = 'CAMPAIGN' | 'GROUP' | 'AD' | 'CREATIVE';

export interface UnifiedPaidEntityIdentity {
  id: string;
  providerEntityId: string;
  kind: UnifiedPaidEntityKind;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  account: {
    id: string;
    provider: UnifiedAdvertisingProvider;
    providerEntityId: string;
    name: string;
    currency: string | null;
  };
  campaign?: { id: string; providerEntityId: string; name: string };
  group?: { id: string; providerEntityId: string; kind: string; name: string } | null;
  metadata: Record<string, unknown>;
}

export interface UnifiedPaidEntityMetricRow {
  period: UnifiedAdvertisingPeriod;
  entityId: string;
  currency: string | null;
  sourceRows: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number | null;
  conversionValue: number | null;
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

export class UnifiedPaidEntityRepository {
  async page(input: {
    accounts: UnifiedAdvertisingAccountRow[];
    kind: UnifiedPaidEntityKind;
    page: number;
    limit: number;
  }): Promise<{ items: UnifiedPaidEntityIdentity[]; total: number }> {
    const accountIds = input.accounts.map((account) => account.id);
    if (accountIds.length === 0) return { items: [], total: 0 };
    const skip = (input.page - 1) * input.limit;
    const accountSelect = {
      id: true,
      provider: true,
      providerEntityId: true,
      name: true,
      currency: true,
    } as const;

    if (input.kind === 'CAMPAIGN') {
      const [rows, total] = await Promise.all([
        prisma.advertisingCampaign.findMany({
          where: { accountId: { in: accountIds }, deletedAt: null },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip,
          take: input.limit,
          select: {
            id: true,
            providerEntityId: true,
            name: true,
            status: true,
            effectiveStatus: true,
            objective: true,
            campaignType: true,
            budgetAmount: true,
            budgetMode: true,
            bidStrategy: true,
            account: { select: accountSelect },
          },
        }),
        prisma.advertisingCampaign.count({
          where: { accountId: { in: accountIds }, deletedAt: null },
        }),
      ]);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          providerEntityId: row.providerEntityId,
          kind: 'CAMPAIGN',
          name: row.name,
          status: row.status,
          effectiveStatus: row.effectiveStatus,
          account: row.account as UnifiedPaidEntityIdentity['account'],
          metadata: {
            objective: row.objective,
            campaignType: row.campaignType,
            budgetAmount: row.budgetAmount == null ? null : Number(row.budgetAmount),
            budgetMode: row.budgetMode,
            bidStrategy: row.bidStrategy,
          },
        })),
      };
    }

    if (input.kind === 'GROUP') {
      const [rows, total] = await Promise.all([
        prisma.advertisingGroup.findMany({
          where: { accountId: { in: accountIds }, deletedAt: null },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip,
          take: input.limit,
          select: {
            id: true,
            providerEntityId: true,
            kind: true,
            name: true,
            status: true,
            effectiveStatus: true,
            optimizationGoal: true,
            bidStrategy: true,
            budgetAmount: true,
            budgetMode: true,
            account: { select: accountSelect },
            campaign: { select: { id: true, providerEntityId: true, name: true } },
          },
        }),
        prisma.advertisingGroup.count({
          where: { accountId: { in: accountIds }, deletedAt: null },
        }),
      ]);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          providerEntityId: row.providerEntityId,
          kind: 'GROUP',
          name: row.name,
          status: row.status,
          effectiveStatus: row.effectiveStatus,
          account: row.account as UnifiedPaidEntityIdentity['account'],
          campaign: row.campaign,
          metadata: {
            groupKind: row.kind,
            optimizationGoal: row.optimizationGoal,
            bidStrategy: row.bidStrategy,
            budgetAmount: row.budgetAmount == null ? null : Number(row.budgetAmount),
            budgetMode: row.budgetMode,
          },
        })),
      };
    }

    if (input.kind === 'AD') {
      const [rows, total] = await Promise.all([
        prisma.advertisingAd.findMany({
          where: { accountId: { in: accountIds }, deletedAt: null },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip,
          take: input.limit,
          select: {
            id: true,
            providerEntityId: true,
            name: true,
            status: true,
            effectiveStatus: true,
            format: true,
            landingPageUrl: true,
            targetScope: true,
            targetScopeConfidence: true,
            account: { select: accountSelect },
            campaign: { select: { id: true, providerEntityId: true, name: true } },
            group: { select: { id: true, providerEntityId: true, kind: true, name: true } },
          },
        }),
        prisma.advertisingAd.count({
          where: { accountId: { in: accountIds }, deletedAt: null },
        }),
      ]);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          providerEntityId: row.providerEntityId,
          kind: 'AD',
          name: row.name,
          status: row.status,
          effectiveStatus: row.effectiveStatus,
          account: row.account as UnifiedPaidEntityIdentity['account'],
          campaign: row.campaign,
          group: row.group,
          metadata: {
            format: row.format,
            landingPageUrl: row.landingPageUrl,
            targetScope: row.targetScope,
            targetScopeConfidence:
              row.targetScopeConfidence == null ? null : Number(row.targetScopeConfidence),
          },
        })),
      };
    }

    const [rows, total] = await Promise.all([
      prisma.advertisingCreative.findMany({
        where: { accountId: { in: accountIds }, deletedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take: input.limit,
        select: {
          id: true,
          providerEntityId: true,
          name: true,
          title: true,
          body: true,
          callToActionType: true,
          imageUrl: true,
          thumbnailUrl: true,
          videoId: true,
          linkUrl: true,
          account: { select: accountSelect },
        },
      }),
      prisma.advertisingCreative.count({
        where: { accountId: { in: accountIds }, deletedAt: null },
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        providerEntityId: row.providerEntityId,
        kind: 'CREATIVE',
        name: row.title ?? row.name ?? `Creative ${row.providerEntityId}`,
        status: null,
        effectiveStatus: null,
        account: row.account as UnifiedPaidEntityIdentity['account'],
        metadata: {
          body: row.body,
          callToActionType: row.callToActionType,
          imageUrl: row.imageUrl,
          thumbnailUrl: row.thumbnailUrl,
          videoId: row.videoId,
          linkUrl: row.linkUrl,
        },
      })),
    };
  }

  async metrics(input: {
    kind: UnifiedPaidEntityKind;
    entityIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
    currency?: string;
  }): Promise<UnifiedPaidEntityMetricRow[]> {
    if (input.entityIds.length === 0) return [];
    const periods = [
      { period: 'CURRENT' as const, from: input.currentFrom, to: input.currentTo },
      { period: 'COMPARISON' as const, from: input.comparisonFrom, to: input.comparisonTo },
    ];
    const chunks = await Promise.all(
      periods.map(async ({ period, from, to }) => {
        const common = {
          date: { gte: from, lte: to },
          ...(input.currency ? { currency: input.currency } : {}),
        };
        if (input.kind === 'CAMPAIGN') {
          const rows = await prisma.advertisingDailyMetric.groupBy({
            by: ['campaignId', 'currency'],
            where: { ...common, level: 'CAMPAIGN', campaignId: { in: input.entityIds } },
            _count: { _all: true, conversions: true, conversionValue: true },
            _sum: {
              spend: true,
              impressions: true,
              clicks: true,
              conversions: true,
              conversionValue: true,
            },
          });
          return rows.flatMap((row) =>
            row.campaignId ? [this.metric(period, row.campaignId, row)] : [],
          );
        }
        if (input.kind === 'GROUP') {
          const rows = await prisma.advertisingDailyMetric.groupBy({
            by: ['groupId', 'currency'],
            where: {
              ...common,
              level: { in: ['GROUP', 'ASSET_GROUP'] },
              groupId: { in: input.entityIds },
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
          return rows.flatMap((row) =>
            row.groupId ? [this.metric(period, row.groupId, row)] : [],
          );
        }
        if (input.kind === 'AD') {
          const rows = await prisma.advertisingDailyMetric.groupBy({
            by: ['adId', 'currency'],
            where: { ...common, level: 'AD', adId: { in: input.entityIds } },
            _count: { _all: true, conversions: true, conversionValue: true },
            _sum: {
              spend: true,
              impressions: true,
              clicks: true,
              conversions: true,
              conversionValue: true,
            },
          });
          return rows.flatMap((row) =>
            row.adId ? [this.metric(period, row.adId, row)] : [],
          );
        }
        const rows = await prisma.advertisingDailyMetric.groupBy({
          by: ['creativeIdSnapshot', 'currency'],
          where: {
            ...common,
            level: 'CREATIVE',
            creativeIdSnapshot: { in: input.entityIds },
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
        return rows.flatMap((row) =>
          row.creativeIdSnapshot
            ? [this.metric(period, row.creativeIdSnapshot, row)]
            : [],
        );
      }),
    );
    return chunks.flat();
  }

  private metric(
    period: UnifiedAdvertisingPeriod,
    entityId: string,
    row: {
      currency: string | null;
      _count: { _all: number; conversions: number; conversionValue: number };
      _sum: {
        spend: Prisma.Decimal | null;
        impressions: bigint | null;
        clicks: bigint | null;
        conversions: Prisma.Decimal | null;
        conversionValue: Prisma.Decimal | null;
      };
    },
  ): UnifiedPaidEntityMetricRow {
    return {
      period,
      entityId,
      currency: row.currency,
      sourceRows: row._count._all,
      spend: decimal(row._sum.spend) ?? 0,
      impressions: integer(row._sum.impressions),
      clicks: integer(row._sum.clicks),
      conversions:
        row._count.conversions === row._count._all ? decimal(row._sum.conversions) : null,
      conversionValue:
        row._count.conversionValue === row._count._all
          ? decimal(row._sum.conversionValue)
          : null,
    };
  }
}
