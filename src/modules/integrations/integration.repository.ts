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

function queueKey(provider: IntegrationProviderName, connectionId: string, resourceType: string) {
  return `${provider}:${connectionId}:${resourceType}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
    const activeQueueKey = queueKey(input.provider, input.connectionId, input.resourceType);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const syncRun = await prisma.syncRun.create({
          data: {
            provider: input.provider,
            resourceType: input.resourceType,
            mode: input.mode,
            apiVersion: input.apiVersion,
            status: 'PENDING',
            activeQueueKey,
            ...syncRunConnectionData(input.provider, input.connectionId),
          },
        });
        return { syncRun, created: true } as const;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const existing = await prisma.syncRun.findUnique({ where: { activeQueueKey } });
        if (existing) return { syncRun: existing, created: false } as const;
      }
    }

    throw new Error('Unable to enqueue sync after resolving a concurrent queue race');
  }

  listClaimableShopifySyncRunIds(resourceType: string, limit: number, expiredAt: Date) {
    return prisma.syncRun.findMany({
      where: {
        provider: 'SHOPIFY',
        resourceType,
        shopifyConnectionId: { not: null },
        activeQueueKey: { not: null },
        OR: [
          { status: 'PENDING' },
          { status: 'RUNNING', leaseExpiresAt: { lte: expiredAt } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  }

  async claimShopifySyncRun(
    syncRunId: string,
    resourceType: string,
    expiredAt: Date,
    leaseExpiresAt: Date,
  ) {
    const startedAt = new Date();
    const claimed = await prisma.syncRun.updateMany({
      where: {
        id: syncRunId,
        provider: 'SHOPIFY',
        resourceType,
        shopifyConnectionId: { not: null },
        activeQueueKey: { not: null },
        OR: [
          { status: 'PENDING' },
          { status: 'RUNNING', leaseExpiresAt: { lte: expiredAt } },
        ],
      },
      data: {
        status: 'RUNNING',
        startedAt,
        leaseExpiresAt,
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
        leaseExpiresAt: true,
        shopifyConnection: { select: { storeId: true } },
      },
    });
  }

  renewShopifySyncRunLease(syncRunId: string, leaseExpiresAt: Date) {
    return prisma.syncRun.updateMany({
      where: {
        id: syncRunId,
        provider: 'SHOPIFY',
        status: 'RUNNING',
        activeQueueKey: { not: null },
      },
      data: { leaseExpiresAt },
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
        activeQueueKey: null,
        leaseExpiresAt: null,
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
      data: {
        status: 'FAILED',
        activeQueueKey: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        lastError,
      },
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
