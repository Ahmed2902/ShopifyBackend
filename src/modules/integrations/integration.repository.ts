import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { INTEGRATION_PROVIDERS, type IntegrationProviderName } from './integration.schema.js';

function syncRunConnectionData(
  provider: IntegrationProviderName,
  connectionId: string,
): Pick<
  Prisma.SyncRunUncheckedCreateInput,
  'shopifyConnectionId' | 'metaConnectionId' | 'tiktokConnectionId'
> {
  return {
    shopifyConnectionId: provider === 'SHOPIFY' ? connectionId : null,
    metaConnectionId: provider === 'META' ? connectionId : null,
    tiktokConnectionId: provider === 'TIKTOK' ? connectionId : null,
  };
}

function syncRunConnectionFilter(
  provider: IntegrationProviderName,
  connectionId: string,
): Prisma.SyncRunWhereInput {
  if (provider === 'SHOPIFY') return { provider, shopifyConnectionId: connectionId };
  if (provider === 'META') return { provider, metaConnectionId: connectionId };
  return { provider, tiktokConnectionId: connectionId };
}

export class IntegrationRepository {
  findSummary(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        shopifyConnection: {
          select: {
            id: true,
            status: true,
            scopes: true,
            apiVersion: true,
            installedAt: true,
            uninstalledAt: true,
            lastSyncedAt: true,
          },
        },
        metaConnection: {
          select: {
            id: true,
            status: true,
            scopes: true,
            apiVersion: true,
            tokenExpiresAt: true,
            lastSyncedAt: true,
            adAccounts: { select: { id: true, metaAccountId: true, name: true, status: true } },
          },
        },
        tiktokConnection: {
          select: {
            id: true,
            status: true,
            scopes: true,
            apiVersion: true,
            accessTokenExpiresAt: true,
            refreshTokenExpiresAt: true,
            lastSyncedAt: true,
            advertisers: { select: { id: true, advertiserId: true, name: true, status: true } },
          },
        },
      },
    });
  }

  createSyncRun(input: {
    provider: IntegrationProviderName;
    connectionId: string;
    resourceType: string;
    mode: string | null;
    apiVersion: string;
  }) {
    return prisma.syncRun.create({
      data: {
        provider: input.provider,
        resourceType: input.resourceType,
        mode: input.mode,
        apiVersion: input.apiVersion,
        status: 'RUNNING',
        startedAt: new Date(),
        ...syncRunConnectionData(input.provider, input.connectionId),
      },
    });
  }

  async enqueueExclusiveSyncRun(input: {
    provider: IntegrationProviderName;
    connectionId: string;
    resourceType: string;
    mode: string | null;
    apiVersion: string;
  }) {
    const lockKey = `${input.provider}:${input.connectionId}:${input.resourceType}`;
    return prisma.$transaction(async (tx) => {
      // Put the void-returning advisory lock in FROM so Prisma only has to deserialize an integer.
      // The xact lock is held until this transaction commits/rolls back.
      await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtext(${lockKey}))
      `);

      const existing = await tx.syncRun.findFirst({
        where: {
          ...syncRunConnectionFilter(input.provider, input.connectionId),
          resourceType: input.resourceType,
          status: { in: ['PENDING', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return { syncRun: existing, created: false } as const;

      const syncRun = await tx.syncRun.create({
        data: {
          provider: input.provider,
          resourceType: input.resourceType,
          mode: input.mode,
          apiVersion: input.apiVersion,
          status: 'PENDING',
          startedAt: null,
          ...syncRunConnectionData(input.provider, input.connectionId),
        },
      });
      return { syncRun, created: true } as const;
    });
  }

  listClaimableShopifySyncRunIds(resourceType: string, limit: number, staleBefore: Date) {
    return prisma.syncRun.findMany({
      where: {
        provider: 'SHOPIFY',
        resourceType,
        shopifyConnectionId: { not: null },
        OR: [
          { status: 'PENDING' },
          { status: 'RUNNING', startedAt: { lte: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  }

  async claimShopifySyncRun(syncRunId: string, resourceType: string, staleBefore: Date) {
    const startedAt = new Date();
    const claimed = await prisma.syncRun.updateMany({
      where: {
        id: syncRunId,
        provider: 'SHOPIFY',
        resourceType,
        shopifyConnectionId: { not: null },
        OR: [
          { status: 'PENDING' },
          { status: 'RUNNING', startedAt: { lte: staleBefore } },
        ],
      },
      data: {
        status: 'RUNNING',
        startedAt,
        finishedAt: null,
        lastError: null,
      },
    });
    if (claimed.count === 0) return null;

    return prisma.syncRun.findUnique({
      where: { id: syncRunId },
      select: {
        id: true,
        startedAt: true,
        shopifyConnection: { select: { storeId: true } },
      },
    });
  }

  attachProviderOperation(syncRunId: string, providerOperationId: string) {
    return prisma.syncRun.update({
      where: { id: syncRunId },
      data: { providerOperationId },
    });
  }

  completeSyncRun(
    syncRunId: string,
    input: { recordsRead: number; recordsWritten: number; partial: boolean },
  ) {
    return prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: input.partial ? 'PARTIAL' : 'SUCCEEDED',
        recordsRead: input.recordsRead,
        recordsWritten: input.recordsWritten,
        finishedAt: new Date(),
        lastError: null,
      },
      include: {
        shopifyConnection: { select: { storeId: true } },
        metaConnection: { select: { storeId: true } },
        tiktokConnection: { select: { storeId: true } },
      },
    });
  }

  failSyncRun(syncRunId: string, lastError: string) {
    return prisma.syncRun.update({
      where: { id: syncRunId },
      data: { status: 'FAILED', finishedAt: new Date(), lastError },
    });
  }

  findShopifySyncRun(storeId: string, syncRunId: string, resourceType: string) {
    return prisma.syncRun.findFirst({
      where: {
        id: syncRunId,
        provider: 'SHOPIFY',
        resourceType,
        shopifyConnection: { is: { storeId } },
      },
      select: {
        id: true,
        status: true,
        providerOperationId: true,
        recordsRead: true,
        recordsWritten: true,
        lastError: true,
        startedAt: true,
        finishedAt: true,
        apiVersion: true,
        shopifyConnectionId: true,
      },
    });
  }

  findLatestShopifySyncRun(storeId: string, resourceType: string) {
    return prisma.syncRun.findFirst({
      where: {
        provider: 'SHOPIFY',
        resourceType,
        shopifyConnection: { is: { storeId } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        providerOperationId: true,
        recordsRead: true,
        recordsWritten: true,
        startedAt: true,
        finishedAt: true,
        lastError: true,
      },
    });
  }

  findLastSuccessfulShopifySyncRun(connectionId: string, resourceType: string) {
    return prisma.syncRun.findFirst({
      where: {
        provider: 'SHOPIFY',
        shopifyConnectionId: connectionId,
        resourceType,
        status: 'SUCCEEDED',
        finishedAt: { not: null },
      },
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
      select: { finishedAt: true },
    });
  }

  createExternalPayload(input: {
    provider: IntegrationProviderName;
    resourceType: string;
    externalId: string | null;
    apiVersion: string;
    payload: Prisma.InputJsonValue;
    syncRunId: string | null;
    webhookDeliveryId: string | null;
  }) {
    return prisma.externalPayload.create({ data: input });
  }

  findConnectionIds(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        shopifyConnection: { select: { id: true } },
        metaConnection: { select: { id: true } },
        tiktokConnection: { select: { id: true } },
      },
    });
  }

  listSyncRuns(
    connectionIds: Partial<Record<IntegrationProviderName, string | null>>,
    provider: IntegrationProviderName | undefined,
    limit: number,
  ) {
    const providers = provider ? [provider] : [...INTEGRATION_PROVIDERS];
    const connections = providers.flatMap((currentProvider) => {
      const connectionId = connectionIds[currentProvider];
      return connectionId ? [syncRunConnectionFilter(currentProvider, connectionId)] : [];
    });

    if (connections.length === 0) return Promise.resolve([]);

    return prisma.syncRun.findMany({
      where: { OR: connections },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
