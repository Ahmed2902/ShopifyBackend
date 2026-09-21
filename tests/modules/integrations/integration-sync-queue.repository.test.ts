import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { IntegrationRepository } from '../../../src/modules/integrations/integration.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStore() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Manual Sync Queue Test Store',
      myshopifyDomain: `manual-sync-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: 'test-token',
          scopes: ['read_products', 'read_inventory', 'read_locations'],
          apiVersion: '2026-07',
        },
      },
    },
    select: { id: true, shopifyConnection: { select: { id: true } } },
  });
  createdStoreIds.push(store.id);
  return store;
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await prisma.syncRun.deleteMany({ where: { shopifyConnection: { is: { storeId } } } });
    await prisma.shopifyConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('IntegrationRepository manual sync queue', () => {
  it('deduplicates concurrent enqueue and allows only one worker claim', async () => {
    const store = await createStore();
    const connectionId = store.shopifyConnection!.id;
    const repository = new IntegrationRepository();
    const input = {
      provider: 'SHOPIFY' as const,
      connectionId,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: '2026-07',
    };

    const [left, right] = await Promise.all([
      repository.enqueueExclusiveSyncRun(input),
      repository.enqueueExclusiveSyncRun(input),
    ]);

    expect(left.syncRun.id).toBe(right.syncRun.id);
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
    expect(left.syncRun.status).toBe('PENDING');
    expect(left.syncRun.activeQueueKey).toBe(`SHOPIFY:${connectionId}:CatalogInventory`);

    const staleBefore = new Date(Date.now() - 30 * 60_000);
    await expect(
      repository.listClaimableShopifySyncRunIds('CatalogInventory', 10, staleBefore),
    ).resolves.toContainEqual({ id: left.syncRun.id });

    const first = await repository.claimShopifySyncRun(
      left.syncRun.id,
      'CatalogInventory',
      staleBefore,
    );
    const second = await repository.claimShopifySyncRun(
      left.syncRun.id,
      'CatalogInventory',
      staleBefore,
    );

    expect(first?.shopifyConnection?.storeId).toBe(store.id);
    expect(first?.startedAt).not.toBeNull();
    expect(first?.leaseExpiresAt).not.toBeNull();
    expect(first?.leaseToken).toEqual(expect.any(String));
    expect(second).toBeNull();
  });

  it('renews an active lease only for the worker that owns its token', async () => {
    const store = await createStore();
    const connectionId = store.shopifyConnection!.id;
    const repository = new IntegrationRepository();
    const queued = await repository.enqueueExclusiveSyncRun({
      provider: 'SHOPIFY',
      connectionId,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: '2026-07',
    });
    const staleBefore = new Date(Date.now() - 30 * 60_000);
    const claim = await repository.claimShopifySyncRun(
      queued.syncRun.id,
      'CatalogInventory',
      staleBefore,
    );
    expect(claim?.leaseToken).toEqual(expect.any(String));

    const beforeRenewal = await prisma.syncRun.findUniqueOrThrow({
      where: { id: queued.syncRun.id },
      select: { leaseExpiresAt: true },
    });
    await expect(
      repository.renewShopifySyncRunLease(queued.syncRun.id, 'wrong-token', new Date()),
    ).resolves.toMatchObject({ count: 0 });
    await expect(
      repository.renewShopifySyncRunLease(queued.syncRun.id, claim!.leaseToken!, new Date()),
    ).resolves.toMatchObject({ count: 1 });
    const afterRenewal = await prisma.syncRun.findUniqueOrThrow({
      where: { id: queued.syncRun.id },
      select: { leaseExpiresAt: true },
    });

    expect(afterRenewal.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      beforeRenewal.leaseExpiresAt!.getTime(),
    );
    await expect(
      repository.listClaimableShopifySyncRunIds('CatalogInventory', 10, staleBefore),
    ).resolves.not.toContainEqual({ id: queued.syncRun.id });
  });

  it('fences a stale worker after another worker reclaims the expired lease', async () => {
    const store = await createStore();
    const connectionId = store.shopifyConnection!.id;
    const repository = new IntegrationRepository();
    const queued = await repository.enqueueExclusiveSyncRun({
      provider: 'SHOPIFY',
      connectionId,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: '2026-07',
    });
    const staleBefore = new Date(Date.now() - 30 * 60_000);
    const firstClaim = await repository.claimShopifySyncRun(
      queued.syncRun.id,
      'CatalogInventory',
      staleBefore,
    );
    expect(firstClaim?.leaseToken).toEqual(expect.any(String));

    await prisma.syncRun.update({
      where: { id: queued.syncRun.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    const secondClaim = await repository.claimShopifySyncRun(
      queued.syncRun.id,
      'CatalogInventory',
      staleBefore,
    );
    expect(secondClaim?.leaseToken).toEqual(expect.any(String));
    expect(secondClaim!.leaseToken).not.toBe(firstClaim!.leaseToken);

    await expect(
      repository.renewShopifySyncRunLease(queued.syncRun.id, firstClaim!.leaseToken!),
    ).resolves.toMatchObject({ count: 0 });
    await expect(
      repository.completeClaimedShopifySyncRun(queued.syncRun.id, firstClaim!.leaseToken!, {
        recordsRead: 1,
        recordsWritten: 1,
        partial: false,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.completeClaimedShopifySyncRun(queued.syncRun.id, secondClaim!.leaseToken!, {
        recordsRead: 10,
        recordsWritten: 10,
        partial: false,
      }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });

  it('allows a worker to reclaim a stale running sync after a process crash', async () => {
    const store = await createStore();
    const connectionId = store.shopifyConnection!.id;
    const repository = new IntegrationRepository();
    const queued = await repository.enqueueExclusiveSyncRun({
      provider: 'SHOPIFY',
      connectionId,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: '2026-07',
    });
    const oldStartedAt = new Date(Date.now() - 60 * 60_000);
    await prisma.syncRun.update({
      where: { id: queued.syncRun.id },
      data: {
        status: 'RUNNING',
        startedAt: oldStartedAt,
        leaseExpiresAt: new Date(Date.now() - 1),
        leaseToken: randomUUID(),
      },
    });

    const staleBefore = new Date(Date.now() - 30 * 60_000);
    await expect(
      repository.listClaimableShopifySyncRunIds('CatalogInventory', 10, staleBefore),
    ).resolves.toContainEqual({ id: queued.syncRun.id });

    const reclaimed = await repository.claimShopifySyncRun(
      queued.syncRun.id,
      'CatalogInventory',
      staleBefore,
    );
    expect(reclaimed?.shopifyConnection?.storeId).toBe(store.id);
    expect(reclaimed!.startedAt!.getTime()).toBeGreaterThan(oldStartedAt.getTime());
    expect(reclaimed!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(reclaimed?.leaseToken).toEqual(expect.any(String));
  });

  it('releases the active queue key on terminal completion so a later manual sync can enqueue', async () => {
    const store = await createStore();
    const connectionId = store.shopifyConnection!.id;
    const repository = new IntegrationRepository();
    const input = {
      provider: 'SHOPIFY' as const,
      connectionId,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: '2026-07',
    };

    const first = await repository.enqueueExclusiveSyncRun(input);
    await repository.completeSyncRun(first.syncRun.id, {
      recordsRead: 10,
      recordsWritten: 10,
      partial: false,
    });
    const second = await repository.enqueueExclusiveSyncRun(input);

    expect(second.created).toBe(true);
    expect(second.syncRun.id).not.toBe(first.syncRun.id);
  });
});
