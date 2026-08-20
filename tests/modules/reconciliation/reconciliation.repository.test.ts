import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ReconciliationRepository } from '../../../src/modules/reconciliation/reconciliation.repository.js';
import { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStore(nextReconciliationAt: Date) {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Reconciliation Test Store',
      myshopifyDomain: `reconcile-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: 'test-token',
          scopes: ['read_products'],
          apiVersion: '2026-07',
          reconciliationIntervalMinutes: 60,
          nextReconciliationAt,
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
    await prisma.shopifyConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('ReconciliationRepository', () => {
  it('selects due work, atomically claims it once, and reschedules after a successful sync', async () => {
    const now = new Date();
    const store = await createStore(new Date(now.getTime() - 60_000));
    const connectionId = store.shopifyConnection!.id;
    const repository = new ReconciliationRepository();

    await expect(
      repository.listDueShopifyConnectionIds(10, now, new Date(now.getTime() - 30 * 60_000)),
    ).resolves.toContain(connectionId);

    const first = await repository.tryClaimShopify(
      connectionId,
      now,
      new Date(now.getTime() - 30 * 60_000),
    );
    const second = await repository.tryClaimShopify(
      connectionId,
      now,
      new Date(now.getTime() - 30 * 60_000),
    );
    expect(first).toEqual({ claimed: true, storeId: store.id });
    expect(second).toEqual({ claimed: false });

    await new ShopifyRepository().markConnectionSynced(connectionId);
    const completed = await prisma.shopifyConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: {
        lastReconciledAt: true,
        nextReconciliationAt: true,
        reconciliationClaimedAt: true,
      },
    });
    expect(completed.lastReconciledAt).not.toBeNull();
    expect(completed.reconciliationClaimedAt).toBeNull();
    expect(completed.nextReconciliationAt!.getTime()).toBeGreaterThan(
      completed.lastReconciledAt!.getTime(),
    );
  });
});
