import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type { StoreService } from '../stores/store.service.js';
import type { IntegrationRepository } from './integration.repository.js';
import type { IntegrationProviderName } from './integration.schema.js';
import { toErrorMessage } from './integration.utils.js';

const READ_ROLES = ['OWNER', 'ADMIN', 'MEMBER'];

export class IntegrationService {
  constructor(
    private readonly repository: IntegrationRepository,
    private readonly storeService: StoreService,
  ) {}

  async getSummary(userId: string, storeId: string) {
    await this.storeService.requireRole(userId, storeId, READ_ROLES);
    const store = await this.repository.findSummary(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    return {
      shopify: store.shopifyConnection,
      meta: store.metaConnection,
    };
  }

  startSyncRun(input: {
    provider: IntegrationProviderName;
    connectionId: string;
    resourceType: string;
    mode?: string;
    apiVersion: string;
  }) {
    return this.repository.createSyncRun({ ...input, mode: input.mode ?? null });
  }

  completeSyncRun(
    syncRunId: string,
    stats: { recordsRead?: number; recordsWritten?: number; partial?: boolean } = {},
  ) {
    return this.repository.completeSyncRun(syncRunId, {
      recordsRead: stats.recordsRead ?? 0,
      recordsWritten: stats.recordsWritten ?? 0,
      partial: stats.partial ?? false,
    });
  }

  failSyncRun(syncRunId: string, error: unknown) {
    return this.repository.failSyncRun(syncRunId, toErrorMessage(error));
  }

  recordExternalPayload(input: {
    provider: IntegrationProviderName;
    resourceType: string;
    externalId?: string;
    apiVersion: string;
    payload: unknown;
    syncRunId?: string;
    webhookDeliveryId?: string;
  }) {
    return this.repository.createExternalPayload({
      provider: input.provider,
      resourceType: input.resourceType,
      externalId: input.externalId ?? null,
      apiVersion: input.apiVersion,
      payload: input.payload as Prisma.InputJsonValue,
      syncRunId: input.syncRunId ?? null,
      webhookDeliveryId: input.webhookDeliveryId ?? null,
    });
  }

  async listRecentSyncRuns(
    userId: string,
    storeId: string,
    provider: IntegrationProviderName | undefined,
    limit: number,
  ) {
    await this.storeService.requireRole(userId, storeId, READ_ROLES);
    const connections = await this.repository.findConnectionIds(storeId);
    if (!connections) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    if (provider === 'SHOPIFY') {
      return connections.shopifyConnection
        ? this.repository.listByShopifyConnection(connections.shopifyConnection.id, limit)
        : [];
    }

    if (provider === 'META') {
      return connections.metaConnection
        ? this.repository.listByMetaConnection(connections.metaConnection.id, limit)
        : [];
    }

    const connectionIds: Array<{ shopifyConnectionId?: string; metaConnectionId?: string }> = [];
    if (connections.shopifyConnection) {
      connectionIds.push({ shopifyConnectionId: connections.shopifyConnection.id });
    }
    if (connections.metaConnection) {
      connectionIds.push({ metaConnectionId: connections.metaConnection.id });
    }

    return connectionIds.length > 0
      ? this.repository.listByConnections(connectionIds, limit)
      : [];
  }
}
