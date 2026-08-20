import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { IntegrationProviderName } from './integration.schema.js';

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
        ...(input.provider === 'SHOPIFY'
          ? { shopifyConnectionId: input.connectionId }
          : { metaConnectionId: input.connectionId }),
      },
    });
  }

  attachProviderOperation(syncRunId: string, providerOperationId: string) {
    return prisma.syncRun.update({
      where: { id: syncRunId },
      data: { providerOperationId },
    });
  }

  updateSyncRunProgress(
    syncRunId: string,
    input: {
      cursor: string | null;
      recordsRead: number;
      recordsWritten: number;
    },
  ) {
    return prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        cursor: input.cursor,
        recordsRead: input.recordsRead,
        recordsWritten: input.recordsWritten,
      },
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
        finishedAt: true,
        apiVersion: true,
        shopifyConnectionId: true,
      },
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
      },
    });
  }

  listByShopifyConnection(connectionId: string, limit: number) {
    return prisma.syncRun.findMany({
      where: { shopifyConnectionId: connectionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  listByMetaConnection(connectionId: string, limit: number) {
    return prisma.syncRun.findMany({
      where: { metaConnectionId: connectionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  listByConnections(
    connections: Array<{ shopifyConnectionId?: string; metaConnectionId?: string }>,
    limit: number,
  ) {
    return prisma.syncRun.findMany({
      where: { OR: connections },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
