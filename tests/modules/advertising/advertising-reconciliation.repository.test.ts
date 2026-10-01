import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { AdvertisingReconciliationRepository } from '../../../src/modules/advertising/reconciliation/advertising-reconciliation.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStore() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Advertising Reconciliation Test Store',
      myshopifyDomain: `paid-reconcile-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
    select: { id: true },
  });
  createdStoreIds.push(store.id);
  return store;
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await prisma.metaConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('AdvertisingReconciliationRepository', () => {
  it('retains even same-kind/same-time webhook work added after the urgent claim', async () => {
    const store = await createStore();
    const repository = new AdvertisingReconciliationRepository();
    const now = new Date();
    await prisma.advertisingReconciliationState.create({ data: { storeId: store.id, provider: 'TIKTOK' } });
    await repository.markUrgent(store.id, 'TIKTOK', ['INSIGHTS'], now);
    const [claim] = await repository.claimDue(1, now, new Date(now.getTime() - 3600_000), 'test-claim');
    expect(claim).toBeDefined();
    await repository.markUrgent(store.id, 'TIKTOK', ['INSIGHTS'], now);
    await repository.completeSuccess({ id: claim!.id, claimToken: 'test-claim', now,
      clearManual: false, clearUrgent: true, claimedUrgentRevision: claim!.urgentRevision, catalogSucceeded: false });
    const persisted = await repository.getState(store.id, 'TIKTOK');
    expect(persisted?.urgentAt).toEqual(now);
    expect(persisted?.urgentKinds).toEqual(['INSIGHTS']);
    const [next] = await repository.claimDue(1, now, new Date(now.getTime() - 3600_000), 'next-claim');
    await repository.completeSuccess({ id: next!.id, claimToken: 'next-claim', now,
      clearManual: false, clearUrgent: true, claimedUrgentRevision: next!.urgentRevision, catalogSucceeded: false });
    expect((await repository.getState(store.id, 'TIKTOK'))?.urgentAt).toBeNull();
  });
  it('queues manual work without erasing an active retry backoff', async () => {
    const store = await createStore();
    const repository = new AdvertisingReconciliationRepository();
    const now = new Date();
    const retryAt = new Date(now.getTime() + 15 * 60_000);

    await prisma.advertisingReconciliationState.create({
      data: {
        storeId: store.id,
        provider: 'META',
        status: 'BACKOFF',
        failureCount: 1,
        retryAt,
        lastStartedAt: new Date(now.getTime() - 10 * 60_000),
        nextDailyAt: new Date(now.getTime() - 60_000),
      },
    });

    await expect(repository.requestManual(store.id, 'META', now, 5 * 60_000)).resolves.toMatchObject({
      kind: 'QUEUED',
    });

    const persisted = await prisma.advertisingReconciliationState.findUniqueOrThrow({
      where: { storeId_provider: { storeId: store.id, provider: 'META' } },
    });
    expect(persisted.status).toBe('BACKOFF');
    expect(persisted.retryAt).toEqual(retryAt);
    expect(persisted.manualRequestedAt).toEqual(now);
  });

  it('coalesces urgent webhook work without bypassing provider retry backoff', async () => {
    const store = await createStore();
    const repository = new AdvertisingReconciliationRepository();
    const now = new Date();
    const retryAt = new Date(now.getTime() + 60 * 60_000);
    const urgentAt = new Date(now.getTime() + 60_000);

    await prisma.advertisingReconciliationState.create({
      data: {
        storeId: store.id,
        provider: 'TIKTOK',
        status: 'BACKOFF',
        failureCount: 2,
        retryAt,
        nextDailyAt: new Date(now.getTime() + 24 * 60 * 60_000),
      },
    });

    await repository.markUrgent(store.id, 'TIKTOK', ['INSIGHTS', 'HIERARCHY'], urgentAt);

    const persisted = await prisma.advertisingReconciliationState.findUniqueOrThrow({
      where: { storeId_provider: { storeId: store.id, provider: 'TIKTOK' } },
    });
    expect(persisted.status).toBe('BACKOFF');
    expect(persisted.retryAt).toEqual(retryAt);
    expect(persisted.urgentAt).toEqual(urgentAt);
    expect(new Set(persisted.urgentKinds)).toEqual(new Set(['INSIGHTS', 'HIERARCHY']));
  });

  it('keeps reauth suspension until the real provider connection changes after suspension', async () => {
    const store = await createStore();
    const repository = new AdvertisingReconciliationRepository();
    const now = new Date();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        status: 'ACTIVE',
        selectedAdAccountIds: ['act_test'],
        accessTokenCiphertext: 'test-token',
        scopes: ['ads_read'],
        apiVersion: 'v24.0',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await prisma.advertisingReconciliationState.create({
      data: {
        storeId: store.id,
        provider: 'META',
        status: 'SUSPENDED',
        suspendedReason: 'META_REAUTH_REQUIRED',
        lastError: 'META_REAUTH_REQUIRED',
      },
    });

    const unchanged = await repository.ensureState({
      storeId: store.id,
      provider: 'META',
      nextDailyAt: new Date(now.getTime() + 24 * 60 * 60_000),
      nextCatalogAt: null,
      connectionUpdatedAt: connection.updatedAt,
    });
    expect(unchanged.status).toBe('SUSPENDED');
    expect(unchanged.nextDailyAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const reconnectedConnection = await prisma.metaConnection.update({
      where: { storeId: store.id },
      data: { metaUserId: 'reconnected-user' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const reconnected = await repository.ensureState({
      storeId: store.id,
      provider: 'META',
      nextDailyAt: new Date(now.getTime() + 24 * 60 * 60_000),
      nextCatalogAt: null,
      connectionUpdatedAt: reconnectedConnection.updatedAt,
    });
    expect(reconnected.status).toBe('IDLE');
    expect(reconnected.suspendedReason).toBeNull();
    expect(reconnected.nextDailyAt).not.toBeNull();
  });
});
