import type { Prisma } from '../../generated/prisma/client.js';
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

const syncRunStoreInclude = {
  shopifyConnection: { select: { storeId: true } },
  metaConnection: { select: { storeId: true } },
  tiktokConnection: { select: { storeId: true } },
} as const;

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
      include: syncRunStoreInclude,
    });
  }

  failSyncRun(syncRunId: string, lastError: string) {
    return prisma.syncRun.update({
      where: { id: syncRunId },
      data: { status: 'FAILED', finishedAt: new Date(), lastError },
      include: syncRunStoreInclude,
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
