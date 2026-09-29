import type {
  AdvertisingProvider,
  AdvertisingReconciliationState,
} from '../../../src/generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import { AdvertisingReconciliationService } from '../../../src/modules/advertising/reconciliation/advertising-reconciliation.service.js';

const now = new Date('2026-09-29T18:00:00.000Z');

function state(
  provider: AdvertisingProvider,
  overrides: Partial<AdvertisingReconciliationState> = {},
): AdvertisingReconciliationState {
  return {
    id: `state-${provider}`,
    storeId: '00000000-0000-0000-0000-000000000001',
    provider,
    status: 'RUNNING',
    nextDailyAt: new Date(now.getTime() - 1),
    nextCatalogAt: null,
    manualRequestedAt: null,
    urgentAt: null,
    urgentKinds: [],
    claimedAt: now,
    claimToken: 'claim',
    lastStartedAt: now,
    lastSucceededAt: null,
    lastCatalogSucceededAt: null,
    failureCount: 0,
    retryAt: null,
    suspendedReason: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function build(input: {
  claimed?: AdvertisingReconciliationState[];
  connection?: { status: string | null; configured: boolean; catalogConfigured: boolean };
  billingError?: Error;
  metaError?: Error;
} = {}) {
  const repository = {
    listConfiguredActiveConnections: vi.fn().mockResolvedValue([]),
    connectionSnapshot: vi.fn().mockResolvedValue(
      input.connection ?? { status: 'ACTIVE', configured: true, catalogConfigured: false },
    ),
    ensureState: vi.fn().mockResolvedValue({}),
    listStates: vi.fn().mockResolvedValue([]),
    requestManual: vi.fn().mockResolvedValue({
      kind: 'QUEUED',
      stateId: 'state-1',
      queuedAt: now,
    }),
    markUrgent: vi.fn().mockResolvedValue({ id: 'state-1' }),
    claimDue: vi.fn().mockResolvedValue(input.claimed ?? []),
    completeSuccess: vi.fn().mockResolvedValue({ count: 1 }),
    completeSkipped: vi.fn().mockResolvedValue({ count: 1 }),
    markBackoff: vi.fn().mockResolvedValue({ count: 1 }),
    exhaustFailure: vi.fn().mockResolvedValue({ count: 1 }),
    suspend: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const billing = {
    requireAdProvider: input.billingError
      ? vi.fn().mockRejectedValue(input.billingError)
      : vi.fn().mockResolvedValue({}),
  };
  const meta = {
    syncInsights: input.metaError
      ? vi.fn().mockRejectedValue(input.metaError)
      : vi.fn().mockResolvedValue({}),
    syncCatalogs: vi.fn().mockResolvedValue({}),
  };
  const tiktok = {
    syncAdsHierarchy: vi.fn().mockResolvedValue({}),
    syncInsights: vi.fn().mockResolvedValue({}),
    syncCatalogs: vi.fn().mockResolvedValue({}),
  };
  const google = { sync: vi.fn().mockResolvedValue({}) };
  const mappings = { projectDeterministicFinalUrls: vi.fn().mockResolvedValue({}) };
  const invalidate = vi.fn().mockResolvedValue(undefined);
  const service = new AdvertisingReconciliationService(
    repository as never,
    billing as never,
    meta as never,
    tiktok as never,
    google as never,
    mappings as never,
    invalidate,
    () => now,
  );
  return { service, repository, billing, meta, tiktok, google, mappings, invalidate };
}

describe('AdvertisingReconciliationService', () => {
  it('runs Meta daily reconciliation through the rolling Insights path and schedules the next day', async () => {
    const claimed = state('META');
    const { service, repository, meta } = build({ claimed: [claimed] });

    await expect(service.processDue()).resolves.toMatchObject({ claimed: 1, succeeded: 1 });

    expect(meta.syncInsights).toHaveBeenCalledWith(claimed.storeId);
    expect(meta.syncCatalogs).not.toHaveBeenCalled();
    expect(repository.completeSuccess).toHaveBeenCalledTimes(1);
    const input = repository.completeSuccess.mock.calls[0]![0];
    expect(input.nextDailyAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 24 * 60 * 60 * 1_000);
    expect(input.nextDailyAt.getTime()).toBeLessThan(now.getTime() + 25 * 60 * 60 * 1_000);
  });

  it('runs catalog reconciliation only when configured and due', async () => {
    const claimed = state('META', {
      nextDailyAt: new Date(now.getTime() + 60_000),
      nextCatalogAt: new Date(now.getTime() - 1),
    });
    const { service, repository, meta } = build({
      claimed: [claimed],
      connection: { status: 'ACTIVE', configured: true, catalogConfigured: true },
    });

    await service.processDue();

    expect(meta.syncInsights).not.toHaveBeenCalled();
    expect(meta.syncCatalogs).toHaveBeenCalledWith(claimed.storeId);
    expect(repository.completeSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ catalogSucceeded: true, clearUrgent: false }),
    );
  });

  it('runs TikTok daily hierarchy and 35-day-default insights together', async () => {
    const claimed = state('TIKTOK');
    const { service, tiktok } = build({ claimed: [claimed] });

    await service.processDue();

    expect(tiktok.syncAdsHierarchy).toHaveBeenCalledWith(claimed.storeId);
    expect(tiktok.syncInsights).toHaveBeenCalledWith(claimed.storeId);
  });

  it('turns a TikTok report webhook into a small two-day insights refresh without hierarchy work', async () => {
    const claimed = state('TIKTOK', {
      nextDailyAt: new Date(now.getTime() + 60_000),
      urgentAt: new Date(now.getTime() - 1),
      urgentKinds: ['INSIGHTS'],
    });
    const { service, repository, tiktok } = build({ claimed: [claimed] });

    await service.processDue();

    expect(tiktok.syncAdsHierarchy).not.toHaveBeenCalled();
    expect(tiktok.syncInsights).toHaveBeenCalledWith(claimed.storeId, 2);
    expect(repository.completeSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ clearUrgent: true }),
    );
  });

  it('runs Google incremental reconciliation, deterministic mapping, and cache invalidation', async () => {
    const claimed = state('GOOGLE_ADS');
    const { service, google, mappings, invalidate } = build({ claimed: [claimed] });

    await service.processDue();

    expect(google.sync).toHaveBeenCalledWith(claimed.storeId, 'INCREMENTAL');
    expect(mappings.projectDeterministicFinalUrls).toHaveBeenCalledWith(claimed.storeId);
    expect(invalidate).toHaveBeenCalledWith(claimed.storeId);
  });

  it('does not call a provider API when the plan does not entitle that advertising channel', async () => {
    const claimed = state('META');
    const { service, repository, meta } = build({
      claimed: [claimed],
      billingError: new AppError('Essentials channel mismatch', 403, 'PLAN_AD_CHANNEL_LIMIT'),
    });

    await expect(service.processDue()).resolves.toMatchObject({ skipped: 1, failed: 0 });

    expect(meta.syncInsights).not.toHaveBeenCalled();
    expect(repository.completeSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'PLAN_AD_CHANNEL_LIMIT' }),
    );
  });

  it('suspends an inactive or reauthorization-required provider before any external call', async () => {
    const claimed = state('META');
    const { service, repository, billing, meta } = build({
      claimed: [claimed],
      connection: { status: 'REAUTH_REQUIRED', configured: true, catalogConfigured: false },
    });

    await expect(service.processDue()).resolves.toMatchObject({ suspended: 1 });

    expect(billing.requireAdProvider).not.toHaveBeenCalled();
    expect(meta.syncInsights).not.toHaveBeenCalled();
    expect(repository.suspend).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'REAUTH_REQUIRED' }),
    );
  });

  it('backs transient failures off at 15 minutes before retrying', async () => {
    const claimed = state('META');
    const { service, repository } = build({
      claimed: [claimed],
      metaError: new Error('temporary provider failure'),
    });

    await expect(service.processDue()).resolves.toMatchObject({ failed: 1 });

    expect(repository.markBackoff).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCount: 1,
        retryAt: new Date(now.getTime() + 15 * 60 * 1_000),
      }),
    );
  });

  it('stops immediate retrying after the bounded 15m/1h/4h retry budget is exhausted', async () => {
    const claimed = state('META', { failureCount: 3 });
    const { service, repository } = build({
      claimed: [claimed],
      metaError: new Error('still failing'),
    });

    await service.processDue();

    expect(repository.markBackoff).not.toHaveBeenCalled();
    expect(repository.exhaustFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: claimed.id, error: 'still failing' }),
    );
  });

  it('caps each worker pass at two provider reconciliations', async () => {
    const { service, repository } = build();

    await service.processDue(50);

    expect(repository.claimDue).toHaveBeenCalledWith(2, now, expect.any(Date), expect.any(String));
  });

  it('keeps manual sync asynchronous and surfaces cooldown without provider calls', async () => {
    const { service, repository, meta } = build();
    repository.requestManual.mockResolvedValueOnce({
      kind: 'COOLDOWN',
      stateId: 'state-1',
      retryAt: new Date(now.getTime() + 60_000),
    });

    await expect(service.requestManual('store-1', 'META')).resolves.toMatchObject({
      provider: 'META',
      status: 'COOLDOWN',
      reconciliationId: 'state-1',
    });
    expect(meta.syncInsights).not.toHaveBeenCalled();
  });
});
