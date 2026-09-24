import { Prisma } from '../../generated/prisma/client.js';

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  ) as Prisma.InputJsonValue;
}

type DecimalInput = Prisma.Decimal | string | number | null | undefined;

function decimal(value: DecimalInput): string | number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Prisma.Decimal ? value.toString() : value;
}

export class AdvertisingWriteRepository {
  upsertAccount(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      storeId: string;
      provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS';
      providerEntityId: string;
      name: string;
      status?: string | null;
      currency?: string | null;
      timezone?: string | null;
      providerData?: unknown;
      rawJson?: unknown;
      lastSyncedAt?: Date | null;
      createdAt?: Date;
      updatedAt?: Date;
    },
  ) {
    const data = {
      storeId: input.storeId,
      provider: input.provider,
      providerEntityId: input.providerEntityId,
      name: input.name,
      status: input.status ?? null,
      currency: input.currency ?? null,
      timezone: input.timezone ?? null,
      providerData: json(input.providerData),
      rawJson: json(input.rawJson),
      lastSyncedAt: input.lastSyncedAt ?? null,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    };
    return tx.advertisingAccount.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        ...data,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
      update: data,
    });
  }

  upsertCampaign(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      accountId: string;
      providerEntityId: string;
      name: string;
      status?: string | null;
      effectiveStatus?: string | null;
      objective?: string | null;
      campaignType?: string | null;
      budgetAmount?: DecimalInput;
      budgetMode?: string | null;
      bidStrategy?: string | null;
      startsAt?: Date | null;
      endsAt?: Date | null;
      providerData?: unknown;
      rawJson?: unknown;
      providerCreatedAt?: Date | null;
      providerUpdatedAt?: Date | null;
      deletedAt?: Date | null;
    },
  ) {
    const data = {
      accountId: input.accountId,
      providerEntityId: input.providerEntityId,
      name: input.name,
      status: input.status ?? null,
      effectiveStatus: input.effectiveStatus ?? null,
      objective: input.objective ?? null,
      campaignType: input.campaignType ?? null,
      budgetAmount: decimal(input.budgetAmount),
      budgetMode: input.budgetMode ?? null,
      bidStrategy: input.bidStrategy ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      providerData: json(input.providerData),
      rawJson: json(input.rawJson),
      providerCreatedAt: input.providerCreatedAt ?? null,
      providerUpdatedAt: input.providerUpdatedAt ?? null,
      deletedAt: input.deletedAt ?? null,
    };
    return tx.advertisingCampaign.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: data,
    });
  }

  upsertGroup(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      accountId: string;
      campaignId: string;
      providerEntityId: string;
      kind: 'AD_SET' | 'AD_GROUP' | 'ASSET_GROUP';
      name: string;
      status?: string | null;
      effectiveStatus?: string | null;
      optimizationGoal?: string | null;
      billingEvent?: string | null;
      bidStrategy?: string | null;
      bidAmount?: DecimalInput;
      budgetAmount?: DecimalInput;
      budgetMode?: string | null;
      targeting?: unknown;
      startsAt?: Date | null;
      endsAt?: Date | null;
      providerData?: unknown;
      rawJson?: unknown;
      providerCreatedAt?: Date | null;
      providerUpdatedAt?: Date | null;
      deletedAt?: Date | null;
    },
  ) {
    const data = {
      accountId: input.accountId,
      campaignId: input.campaignId,
      providerEntityId: input.providerEntityId,
      kind: input.kind,
      name: input.name,
      status: input.status ?? null,
      effectiveStatus: input.effectiveStatus ?? null,
      optimizationGoal: input.optimizationGoal ?? null,
      billingEvent: input.billingEvent ?? null,
      bidStrategy: input.bidStrategy ?? null,
      bidAmount: decimal(input.bidAmount),
      budgetAmount: decimal(input.budgetAmount),
      budgetMode: input.budgetMode ?? null,
      targeting: json(input.targeting),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      providerData: json(input.providerData),
      rawJson: json(input.rawJson),
      providerCreatedAt: input.providerCreatedAt ?? null,
      providerUpdatedAt: input.providerUpdatedAt ?? null,
      deletedAt: input.deletedAt ?? null,
    };
    return tx.advertisingGroup.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: data,
    });
  }

  upsertCreative(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      accountId: string;
      providerEntityId: string;
      name?: string | null;
      title?: string | null;
      body?: string | null;
      callToActionType?: string | null;
      imageUrl?: string | null;
      thumbnailUrl?: string | null;
      videoId?: string | null;
      linkUrl?: string | null;
      providerData?: unknown;
      rawJson?: unknown;
      providerCreatedAt?: Date | null;
      providerUpdatedAt?: Date | null;
      deletedAt?: Date | null;
    },
  ) {
    const data = {
      accountId: input.accountId,
      providerEntityId: input.providerEntityId,
      name: input.name ?? null,
      title: input.title ?? null,
      body: input.body ?? null,
      callToActionType: input.callToActionType ?? null,
      imageUrl: input.imageUrl ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      videoId: input.videoId ?? null,
      linkUrl: input.linkUrl ?? null,
      providerData: json(input.providerData),
      rawJson: json(input.rawJson),
      providerCreatedAt: input.providerCreatedAt ?? null,
      providerUpdatedAt: input.providerUpdatedAt ?? null,
      deletedAt: input.deletedAt ?? null,
    };
    return tx.advertisingCreative.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: data,
    });
  }

  upsertAd(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      accountId: string;
      campaignId: string;
      groupId?: string | null;
      creativeId?: string | null;
      providerEntityId: string;
      name: string;
      status?: string | null;
      effectiveStatus?: string | null;
      format?: string | null;
      landingPageUrl?: string | null;
      targetScope?: 'STORE' | 'COLLECTION' | 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT' | 'MULTI_PRODUCT' | 'UNKNOWN';
      targetScopeConfidence?: DecimalInput;
      targetScopeEvidence?: unknown;
      providerData?: unknown;
      rawJson?: unknown;
      providerCreatedAt?: Date | null;
      providerUpdatedAt?: Date | null;
      deletedAt?: Date | null;
    },
  ) {
    const data = {
      accountId: input.accountId,
      campaignId: input.campaignId,
      groupId: input.groupId ?? null,
      creativeId: input.creativeId ?? null,
      providerEntityId: input.providerEntityId,
      name: input.name,
      status: input.status ?? null,
      effectiveStatus: input.effectiveStatus ?? null,
      format: input.format ?? null,
      landingPageUrl: input.landingPageUrl ?? null,
      targetScope: input.targetScope ?? ('UNKNOWN' as const),
      targetScopeConfidence: decimal(input.targetScopeConfidence),
      targetScopeEvidence: json(input.targetScopeEvidence),
      providerData: json(input.providerData),
      rawJson: json(input.rawJson),
      providerCreatedAt: input.providerCreatedAt ?? null,
      providerUpdatedAt: input.providerUpdatedAt ?? null,
      deletedAt: input.deletedAt ?? null,
    };
    return tx.advertisingAd.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: data,
    });
  }

  upsertDailyMetric(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      metricKey: string;
      accountId: string;
      campaignId?: string | null;
      groupId?: string | null;
      adId?: string | null;
      creativeIdSnapshot?: string | null;
      level: 'ACCOUNT' | 'CAMPAIGN' | 'GROUP' | 'AD' | 'CREATIVE' | 'ASSET_GROUP';
      date: Date;
      currency?: string | null;
      spend?: DecimalInput;
      impressions?: bigint | number | null;
      reach?: bigint | number | null;
      clicks?: bigint | number | null;
      conversions?: DecimalInput;
      conversionValue?: DecimalInput;
      ctr?: DecimalInput;
      cpc?: DecimalInput;
      cpm?: DecimalInput;
      frequency?: DecimalInput;
      cpa?: DecimalInput;
      roas?: DecimalInput;
      providerMetrics?: unknown;
      breakdownHash?: string | null;
      breakdownJson?: unknown;
      rawJson?: unknown;
      syncedAt?: Date;
    },
  ) {
    const data = {
      accountId: input.accountId,
      campaignId: input.campaignId ?? null,
      groupId: input.groupId ?? null,
      adId: input.adId ?? null,
      creativeIdSnapshot: input.creativeIdSnapshot ?? null,
      level: input.level,
      date: input.date,
      currency: input.currency ?? null,
      spend: decimal(input.spend) ?? 0,
      impressions: input.impressions ?? 0,
      reach: input.reach ?? null,
      clicks: input.clicks ?? 0,
      conversions: decimal(input.conversions),
      conversionValue: decimal(input.conversionValue),
      ctr: decimal(input.ctr),
      cpc: decimal(input.cpc),
      cpm: decimal(input.cpm),
      frequency: decimal(input.frequency),
      cpa: decimal(input.cpa),
      roas: decimal(input.roas),
      providerMetrics: json(input.providerMetrics),
      breakdownHash: input.breakdownHash ?? null,
      breakdownJson: json(input.breakdownJson),
      rawJson: json(input.rawJson),
      syncedAt: input.syncedAt ?? new Date(),
    };
    return tx.advertisingDailyMetric.upsert({
      where: { metricKey: input.metricKey },
      create: { id: input.id, metricKey: input.metricKey, ...data },
      update: data,
    });
  }
}

export const advertisingWriteRepository = new AdvertisingWriteRepository();
