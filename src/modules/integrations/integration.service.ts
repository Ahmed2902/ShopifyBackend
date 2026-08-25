import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { IntegrationRepository } from './integration.repository.js';
import type { IntegrationProviderName } from './integration.schema.js';
import { toErrorMessage } from './integration.utils.js';

export class IntegrationService {
  constructor(private readonly repository: IntegrationRepository) {}

  async getSummary(storeId: string) {
    const store = await this.repository.findSummary(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return {
      shopify: store.shopifyConnection,
      meta: store.metaConnection,
      tiktok: store.tiktokConnection,
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

  attachProviderOperation(syncRunId: string, providerOperationId: string) {
    return this.repository.attachProviderOperation(syncRunId, providerOperationId);
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

  getShopifySyncRun(storeId: string, syncRunId: string, resourceType: string) {
    return this.repository.findShopifySyncRun(storeId, syncRunId, resourceType);
  }

  getLatestShopifySyncRun(storeId: string, resourceType: string) {
    return this.repository.findLatestShopifySyncRun(storeId, resourceType);
  }

  getLastSuccessfulShopifySyncRun(connectionId: string, resourceType: string) {
    return this.repository.findLastSuccessfulShopifySyncRun(connectionId, resourceType);
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
    storeId: string,
    provider: IntegrationProviderName | undefined,
    limit: number,
  ) {
    const connections = await this.repository.findConnectionIds(storeId);
    if (!connections) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    return this.repository.listSyncRuns(
      {
        SHOPIFY: connections.shopifyConnection?.id ?? null,
        META: connections.metaConnection?.id ?? null,
        TIKTOK: connections.tiktokConnection?.id ?? null,
      },
      provider,
      limit,
    );
  }
}

// Keep construction close to the feature instead of in a separate *.module.ts file.
export const integrationService = new IntegrationService(new IntegrationRepository());
