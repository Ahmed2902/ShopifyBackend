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
    expect(second).toBeNull();
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
      data: { status: 'RUNNING', startedAt: oldStartedAt },
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
  });
});
