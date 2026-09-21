import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { IntegrationRepository } from './integration.repository.js';
import type { IntegrationProviderName } from './integration.schema.js';
import { toErrorMessage } from './integration.utils.js';

function storeIdFromSyncRun(run: {
  shopifyConnection?: { storeId: string } | null;
  metaConnection?: { storeId: string } | null;
  tiktokConnection?: { storeId: string } | null;
}) {
  return (
    run.shopifyConnection?.storeId ??
    run.metaConnection?.storeId ??
    run.tiktokConnection?.storeId ??
    null
  );
}

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

  enqueueExclusiveSyncRun(input: {
    provider: IntegrationProviderName;
    connectionId: string;
    resourceType: string;
    mode?: string;
    apiVersion: string;
  }) {
    return this.repository.enqueueExclusiveSyncRun({ ...input, mode: input.mode ?? null });
  }

  async listClaimableShopifySyncRunIds(resourceType: string, limit: number, staleBefore: Date) {
    const rows = await this.repository.listClaimableShopifySyncRunIds(
      resourceType,
      limit,
      staleBefore,
    );
    return rows.map((row) => row.id);
  }

  claimShopifySyncRun(syncRunId: string, resourceType: string, staleBefore: Date) {
    return this.repository.claimShopifySyncRun(syncRunId, resourceType, staleBefore);
  }

  renewShopifySyncRunLease(syncRunId: string, leaseToken: string, now = new Date()) {
    return this.repository.renewShopifySyncRunLease(syncRunId, leaseToken, now);
  }

  async completeClaimedShopifySyncRun(
    syncRunId: string,
    leaseToken: string,
    stats: { recordsRead?: number; recordsWritten?: number; partial?: boolean } = {},
  ) {
    const completed = await this.repository.completeClaimedShopifySyncRun(syncRunId, leaseToken, {
      recordsRead: stats.recordsRead ?? 0,
      recordsWritten: stats.recordsWritten ?? 0,
      partial: stats.partial ?? false,
    });
    if (!completed) return null;

    const storeId = storeIdFromSyncRun(completed);
    if (storeId) await invalidateStoreDecisionCaches(storeId);
    return completed;
  }

  async failClaimedShopifySyncRun(syncRunId: string, leaseToken: string, error: unknown) {
    const failed = await this.repository.failClaimedShopifySyncRun(
      syncRunId,
      leaseToken,
      toErrorMessage(error),
    );
    if (!failed) return null;

    const storeId = storeIdFromSyncRun(failed);
    if (storeId) await invalidateStoreDecisionCaches(storeId);
    return failed;
  }

  attachProviderOperation(syncRunId: string, providerOperationId: string) {
    return this.repository.attachProviderOperation(syncRunId, providerOperationId);
  }

  async completeSyncRun(
    syncRunId: string,
    stats: { recordsRead?: number; recordsWritten?: number; partial?: boolean } = {},
  ) {
    const completed = await this.repository.completeSyncRun(syncRunId, {
      recordsRead: stats.recordsRead ?? 0,
      recordsWritten: stats.recordsWritten ?? 0,
      partial: stats.partial ?? false,
    });

    // Source writes are committed before the SyncRun status changes. Advance Store generations for
    // both complete and partial success so old analytical payloads cannot outlive provider writes.
    const storeId = storeIdFromSyncRun(completed);
    if (storeId) await invalidateStoreDecisionCaches(storeId);
    return completed;
  }

  async failSyncRun(syncRunId: string, error: unknown) {
    const failed = await this.repository.failSyncRun(syncRunId, toErrorMessage(error));

    // A provider sync can commit one or more pages before a later page fails. Invalidate on failure
    // as well: source truth may have changed even though the overall run did not succeed.
    const storeId = storeIdFromSyncRun(failed);
    if (storeId) await invalidateStoreDecisionCaches(storeId);
    return failed;
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

export const integrationService = new IntegrationService(new IntegrationRepository());
