import { Prisma, type AdvertisingProvider } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

export type ProviderConnectionSnapshot = {
  status: string | null;
  configured: boolean;
  catalogConfigured: boolean;
  updatedAt: Date | null;
};

type ConfiguredConnection = {
  storeId: string;
  provider: AdvertisingProvider;
  catalogConfigured: boolean;
  updatedAt: Date;
};

export class AdvertisingReconciliationRepository {
  async listConfiguredActiveConnections(): Promise<ConfiguredConnection[]> {
    const [meta, tiktok, google] = await Promise.all([
      prisma.metaConnection.findMany({
        where: { status: 'ACTIVE' },
        select: {
          storeId: true,
          selectedAdAccountIds: true,
          selectedCatalogIds: true,
          updatedAt: true,
        },
      }),
      prisma.tikTokConnection.findMany({
        where: { status: 'ACTIVE' },
        select: {
          storeId: true,
          selectedAdvertiserIds: true,
          selectedCatalogIds: true,
          updatedAt: true,
        },
      }),
      prisma.googleAdsConnection.findMany({
        where: { status: 'ACTIVE' },
        select: { storeId: true, selectedCustomerIds: true, updatedAt: true },
      }),
    ]);

    return [
      ...meta
        .filter((connection) => connection.selectedAdAccountIds.length > 0)
        .map((connection) => ({
          storeId: connection.storeId,
          provider: 'META' as const,
          catalogConfigured: connection.selectedCatalogIds.length > 0,
          updatedAt: connection.updatedAt,
        })),
      ...tiktok
        .filter((connection) => connection.selectedAdvertiserIds.length > 0)
        .map((connection) => ({
          storeId: connection.storeId,
          provider: 'TIKTOK' as const,
          catalogConfigured: connection.selectedCatalogIds.length > 0,
          updatedAt: connection.updatedAt,
        })),
      ...google
        .filter((connection) => connection.selectedCustomerIds.length > 0)
        .map((connection) => ({
          storeId: connection.storeId,
          provider: 'GOOGLE_ADS' as const,
          catalogConfigured: false,
          updatedAt: connection.updatedAt,
        })),
    ];
  }

  async connectionSnapshot(
    storeId: string,
    provider: AdvertisingProvider,
  ): Promise<ProviderConnectionSnapshot> {
    if (provider === 'META') {
      const connection = await prisma.metaConnection.findUnique({
        where: { storeId },
        select: {
          status: true,
          selectedAdAccountIds: true,
          selectedCatalogIds: true,
          updatedAt: true,
        },
      });
      return {
        status: connection?.status ?? null,
        configured: (connection?.selectedAdAccountIds.length ?? 0) > 0,
        catalogConfigured: (connection?.selectedCatalogIds.length ?? 0) > 0,
        updatedAt: connection?.updatedAt ?? null,
      };
    }
    if (provider === 'TIKTOK') {
      const connection = await prisma.tikTokConnection.findUnique({
        where: { storeId },
        select: {
          status: true,
          selectedAdvertiserIds: true,
          selectedCatalogIds: true,
          updatedAt: true,
        },
      });
      return {
        status: connection?.status ?? null,
        configured: (connection?.selectedAdvertiserIds.length ?? 0) > 0,
        catalogConfigured: (connection?.selectedCatalogIds.length ?? 0) > 0,
        updatedAt: connection?.updatedAt ?? null,
      };
    }
    const connection = await prisma.googleAdsConnection.findUnique({
      where: { storeId },
      select: { status: true, selectedCustomerIds: true, updatedAt: true },
    });
    return {
      status: connection?.status ?? null,
      configured: (connection?.selectedCustomerIds.length ?? 0) > 0,
      catalogConfigured: false,
      updatedAt: connection?.updatedAt ?? null,
    };
  }

  async ensureState(input: {
    storeId: string;
    provider: AdvertisingProvider;
    nextDailyAt: Date;
    nextCatalogAt: Date | null;
    connectionUpdatedAt: Date | null;
  }) {
    const existing = await prisma.advertisingReconciliationState.upsert({
      where: { storeId_provider: { storeId: input.storeId, provider: input.provider } },
      create: {
        storeId: input.storeId,
        provider: input.provider,
        nextDailyAt: input.nextDailyAt,
        nextCatalogAt: input.nextCatalogAt,
      },
      update: {},
    });

    const reconnectedAfterSuspension =
      existing.status === 'SUSPENDED' &&
      input.connectionUpdatedAt !== null &&
      input.connectionUpdatedAt > existing.updatedAt;
    if (existing.status === 'SUSPENDED' && !reconnectedAfterSuspension) return existing;

    const needsDaily = existing.nextDailyAt === null;
    const needsCatalog = input.nextCatalogAt !== null && existing.nextCatalogAt === null;
    const removeCatalog = input.nextCatalogAt === null && existing.nextCatalogAt !== null;
    if (!reconnectedAfterSuspension && !needsDaily && !needsCatalog && !removeCatalog) {
      return existing;
    }

    return prisma.advertisingReconciliationState.update({
      where: { id: existing.id },
      data: {
        ...(reconnectedAfterSuspension
          ? { status: 'IDLE', suspendedReason: null, lastError: null }
          : {}),
        ...(needsDaily ? { nextDailyAt: input.nextDailyAt } : {}),
        ...(needsCatalog ? { nextCatalogAt: input.nextCatalogAt } : {}),
        ...(removeCatalog ? { nextCatalogAt: null } : {}),
      },
    });
  }

  listStates(storeId: string) {
    return prisma.advertisingReconciliationState.findMany({
      where: { storeId },
      orderBy: { provider: 'asc' },
    });
  }

  getState(storeId: string, provider: AdvertisingProvider) {
    return prisma.advertisingReconciliationState.findUnique({
      where: { storeId_provider: { storeId, provider } },
    });
  }

  async requestManual(
    storeId: string,
    provider: AdvertisingProvider,
    now: Date,
    cooldownMs: number,
  ) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        claimedAt: Date | null;
        manualRequestedAt: Date | null;
        lastStartedAt: Date | null;
      }>>(Prisma.sql`
        SELECT "id", "status", "claimedAt", "manualRequestedAt", "lastStartedAt"
        FROM "AdvertisingReconciliationState"
        WHERE "storeId" = ${storeId}::uuid AND "provider" = ${provider}::"AdvertisingProvider"
        FOR UPDATE
      `);
      const state = rows[0];
      if (!state) return { kind: 'MISSING' as const };
      if (state.status === 'RUNNING' || state.claimedAt) {
        return { kind: 'RUNNING' as const, stateId: state.id };
      }
      if (state.manualRequestedAt) {
        return { kind: 'QUEUED' as const, stateId: state.id, queuedAt: state.manualRequestedAt };
      }
      if (state.lastStartedAt) {
        const retryAt = new Date(state.lastStartedAt.getTime() + cooldownMs);
        if (retryAt > now) {
          return { kind: 'COOLDOWN' as const, stateId: state.id, retryAt };
        }
      }
      await tx.advertisingReconciliationState.update({
        where: { id: state.id },
        data: { manualRequestedAt: now },
      });
      return { kind: 'QUEUED' as const, stateId: state.id, queuedAt: now };
    });
  }

  async markUrgent(
    storeId: string,
    provider: AdvertisingProvider,
    kinds: string[],
    dueAt: Date,
  ) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string;
        urgentAt: Date | null;
        urgentKinds: string[];
      }>>(Prisma.sql`
        SELECT "id", "urgentAt", "urgentKinds"
        FROM "AdvertisingReconciliationState"
        WHERE "storeId" = ${storeId}::uuid AND "provider" = ${provider}::"AdvertisingProvider"
        FOR UPDATE
      `);
      const state = rows[0];
      if (!state) return null;
      const urgentAt = state.urgentAt && state.urgentAt < dueAt ? state.urgentAt : dueAt;
      const urgentKinds = [...new Set([...state.urgentKinds, ...kinds])];
      return tx.advertisingReconciliationState.update({
        where: { id: state.id },
        data: { urgentAt, urgentKinds },
      });
    });
  }

  async claimDue(limit: number, now: Date, staleBefore: Date, claimToken: string) {
    return prisma.$transaction(async (tx) => {
      const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "AdvertisingReconciliationState"
        WHERE "status" <> 'SUSPENDED'
          AND ("claimedAt" IS NULL OR "claimedAt" <= ${staleBefore})
          AND ("retryAt" IS NULL OR "retryAt" <= ${now})
          AND (
            "manualRequestedAt" IS NOT NULL
            OR ("urgentAt" IS NOT NULL AND "urgentAt" <= ${now})
            OR ("nextDailyAt" IS NOT NULL AND "nextDailyAt" <= ${now})
            OR ("nextCatalogAt" IS NOT NULL AND "nextCatalogAt" <= ${now})
          )
        ORDER BY
          CASE
            WHEN "manualRequestedAt" IS NOT NULL THEN 0
            WHEN "urgentAt" IS NOT NULL AND "urgentAt" <= ${now} THEN 1
            WHEN "retryAt" IS NOT NULL AND "retryAt" <= ${now} THEN 2
            WHEN "nextDailyAt" IS NOT NULL AND "nextDailyAt" <= ${now} THEN 3
            ELSE 4
          END,
          COALESCE("manualRequestedAt", "urgentAt", "retryAt", "nextDailyAt", "nextCatalogAt") ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      if (ids.length === 0) return [];
      const values = ids.map((row) => row.id);
      await tx.advertisingReconciliationState.updateMany({
        where: { id: { in: values } },
        data: { status: 'RUNNING', claimedAt: now, claimToken, lastStartedAt: now },
      });
      return tx.advertisingReconciliationState.findMany({ where: { id: { in: values } } });
    });
  }

  completeSuccess(input: {
    id: string;
    claimToken: string;
    now: Date;
    nextDailyAt?: Date;
    nextCatalogAt?: Date;
    clearManual: boolean;
    clearUrgent: boolean;
    catalogSucceeded: boolean;
  }) {
    return prisma.advertisingReconciliationState.updateMany({
      where: { id: input.id, claimToken: input.claimToken },
      data: {
        status: 'IDLE',
        claimedAt: null,
        claimToken: null,
        failureCount: 0,
        retryAt: null,
        lastError: null,
        suspendedReason: null,
        lastSucceededAt: input.now,
        ...(input.catalogSucceeded ? { lastCatalogSucceededAt: input.now } : {}),
        ...(input.nextDailyAt ? { nextDailyAt: input.nextDailyAt } : {}),
        ...(input.nextCatalogAt ? { nextCatalogAt: input.nextCatalogAt } : {}),
        ...(input.clearManual ? { manualRequestedAt: null } : {}),
        ...(input.clearUrgent ? { urgentAt: null, urgentKinds: [] } : {}),
      },
    });
  }

  completeSkipped(input: {
    id: string;
    claimToken: string;
    nextDailyAt: Date;
    nextCatalogAt: Date | null;
    reason: string;
  }) {
    return prisma.advertisingReconciliationState.updateMany({
      where: { id: input.id, claimToken: input.claimToken },
      data: {
        status: 'IDLE',
        claimedAt: null,
        claimToken: null,
        retryAt: null,
        failureCount: 0,
        nextDailyAt: input.nextDailyAt,
        nextCatalogAt: input.nextCatalogAt,
        manualRequestedAt: null,
        urgentAt: null,
        urgentKinds: [],
        lastError: input.reason,
      },
    });
  }

  markBackoff(input: {
    id: string;
    claimToken: string;
    failureCount: number;
    retryAt: Date;
    error: string;
  }) {
    return prisma.advertisingReconciliationState.updateMany({
      where: { id: input.id, claimToken: input.claimToken },
      data: {
        status: 'BACKOFF',
        claimedAt: null,
        claimToken: null,
        failureCount: input.failureCount,
        retryAt: input.retryAt,
        lastError: input.error,
      },
    });
  }

  exhaustFailure(input: {
    id: string;
    claimToken: string;
    nextDailyAt: Date;
    nextCatalogAt?: Date | null;
    error: string;
  }) {
    return prisma.advertisingReconciliationState.updateMany({
      where: { id: input.id, claimToken: input.claimToken },
      data: {
        status: 'IDLE',
        claimedAt: null,
        claimToken: null,
        failureCount: 0,
        retryAt: null,
        nextDailyAt: input.nextDailyAt,
        ...(input.nextCatalogAt !== undefined ? { nextCatalogAt: input.nextCatalogAt } : {}),
        manualRequestedAt: null,
        urgentAt: null,
        urgentKinds: [],
        lastError: input.error,
      },
    });
  }

  suspend(input: { id: string; claimToken?: string; reason: string }) {
    return prisma.advertisingReconciliationState.updateMany({
      where: { id: input.id, ...(input.claimToken ? { claimToken: input.claimToken } : {}) },
      data: {
        status: 'SUSPENDED',
        claimedAt: null,
        claimToken: null,
        retryAt: null,
        nextDailyAt: null,
        nextCatalogAt: null,
        manualRequestedAt: null,
        urgentAt: null,
        urgentKinds: [],
        suspendedReason: input.reason,
        lastError: input.reason,
      },
    });
  }
}
