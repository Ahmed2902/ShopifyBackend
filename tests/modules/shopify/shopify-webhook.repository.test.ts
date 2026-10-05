import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyWebhookRepository } from '../../../src/modules/shopify/webhook/shopify-webhook.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createConnectedStore() {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: 'Webhook Repository Test Store',
      myshopifyDomain: `webhook-repository-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: 'test-token',
          scopes: ['read_products', 'read_inventory', 'read_locations', 'read_orders'],
          apiVersion: '2026-07',
        },
      },
    },
    select: {
      id: true,
      shopifyConnection: { select: { id: true } },
    },
  });
  createdStoreIds.push(store.id);
  return store;
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    const connection = await prisma.shopifyConnection.findUnique({
      where: { storeId },
      select: { id: true },
    });
    if (connection) {
      await prisma.webhookDelivery.deleteMany({ where: { shopifyConnectionId: connection.id } });
      await prisma.shopifyConnection.delete({ where: { id: connection.id } });
    }
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('ShopifyWebhookRepository', () => {
  it('deduplicates deliveries and atomically claims a queued delivery once', async () => {
    const store = await createConnectedStore();
    const repository = new ShopifyWebhookRepository();
    const first = await repository.createDelivery({
      externalDeliveryId: 'delivery-one',
      shopifyConnectionId: store.shopifyConnection!.id,
      topic: 'products/update',
      apiVersion: '2026-07',
      triggeredAt: new Date('2026-08-20T16:00:00.000Z'),
      payload: { id: 1 },
    });
    const second = await repository.createDelivery({
      externalDeliveryId: 'delivery-one',
      shopifyConnectionId: store.shopifyConnection!.id,
      topic: 'products/update',
      apiVersion: '2026-07',
      triggeredAt: null,
      payload: { id: 1 },
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.delivery.id).toBe(first.delivery.id);

    const now = new Date(Date.now() + 1000);
    const staleBefore = new Date(now.getTime() - 15 * 60_000);
    expect(await repository.tryClaim(first.delivery.id, now, staleBefore)).toBe(true);
    expect(await repository.tryClaim(first.delivery.id, now, staleBefore)).toBe(false);

    const claimed = await repository.getDelivery(first.delivery.id);
    expect(claimed?.attempts).toBe(1);
    expect(
      await prisma.webhookDelivery.findUnique({
        where: { id: first.delivery.id },
        select: { status: true, processingStartedAt: true },
      }),
    ).toMatchObject({ status: 'PROCESSING' });
  });

  it('moves a failed delivery back into the due queue with bounded retry state', async () => {
    const store = await createConnectedStore();
    const repository = new ShopifyWebhookRepository();
    const created = await repository.createDelivery({
      externalDeliveryId: 'delivery-retry',
      shopifyConnectionId: store.shopifyConnection!.id,
      topic: 'orders/updated',
      apiVersion: '2026-07',
      triggeredAt: null,
      payload: { id: 99 },
    });
    const now = new Date(Date.now() + 1000);
    await repository.tryClaim(
      created.delivery.id,
      now,
      new Date(now.getTime() - 15 * 60_000),
    );
    await repository.markFailed(created.delivery.id, 1, 'temporary failure');

    const failed = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: created.delivery.id },
      select: { status: true, nextAttemptAt: true, lastError: true },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(failed.lastError).toBe('temporary failure');
  });
  it('atomically clears credentials, cancels access and revokes MCP grants on uninstall', async () => {
    const store = await createConnectedStore(); const repository = new ShopifyWebhookRepository();
    const before = new Date(Date.now() - 1000); const now = new Date();
    await prisma.shopifyConnection.update({ where: { id: store.shopifyConnection!.id }, data: { installedAt: before, refreshTokenCiphertext: 'refresh', refreshTokenExpiresAt: new Date(Date.now() + 86400_000) } });
    await prisma.storeSubscription.create({ data: { storeId: store.id, provider: 'SHOPIFY', status: 'ACTIVE', selectedPlan: 'PRO', trialStartedAt: before, trialEndsAt: before, lastVerifiedAt: before } });
    const token = await prisma.mcpRefreshToken.create({ data: { tokenHash: randomUUID(), userId: randomUUID(), storeId: store.id, clientId: 'test', resource: 'test', scopes: [], expiresAt: new Date(Date.now() + 86400_000) } });
    try {
      expect(await repository.markConnectionUninstalled(store.shopifyConnection!.id, now)).toBe(true);
      expect(await prisma.shopifyConnection.findUnique({ where: { id: store.shopifyConnection!.id } })).toMatchObject({ status: 'UNINSTALLED', accessTokenCiphertext: '', refreshTokenCiphertext: null, nextReconciliationAt: null });
      expect(await prisma.storeSubscription.findUnique({ where: { storeId: store.id } })).toMatchObject({ status: 'CANCELED', lastVerifiedAt: null, trialEndsAt: now });
      expect(await prisma.mcpRefreshToken.findUnique({ where: { id: token.id } })).toMatchObject({ revokedAt: now });
    } finally { await prisma.mcpRefreshToken.delete({ where: { id: token.id } }); }
  });

  it('leaves a newer reinstall untouched when an older uninstall arrives', async () => {
    const store = await createConnectedStore(); const repository = new ShopifyWebhookRepository();
    const eventAt = new Date(Date.now() - 86400_000);
    expect(await repository.markConnectionUninstalled(store.shopifyConnection!.id, eventAt)).toBe(false);
    expect(await prisma.shopifyConnection.findUnique({ where: { id: store.shopifyConnection!.id } })).toMatchObject({ status: 'ACTIVE', accessTokenCiphertext: 'test-token' });
  });

});

describeDatabase('Scope updates across reinstall', () => {
  it('rejects old scope changes and accepts a current delivery against the actual connection generation', async () => {
    const store = await createConnectedStore();
    const repository = new ShopifyWebhookRepository();
    const installedAt = new Date();
    await prisma.shopifyConnection.update({ where: { id: store.shopifyConnection!.id }, data: { installedAt, scopes: ['read_orders'] } });
    expect(await repository.updateConnectionScopes(store.shopifyConnection!.id, ['write_products'], new Date(installedAt.getTime() - 1))).toBe(false);
    expect(await prisma.shopifyConnection.findUniqueOrThrow({ where: { id: store.shopifyConnection!.id } })).toMatchObject({ scopes: ['read_orders'] });
    expect(await repository.updateConnectionScopes(store.shopifyConnection!.id, ['read_products'], installedAt)).toBe(true);
    expect(await prisma.shopifyConnection.findUniqueOrThrow({ where: { id: store.shopifyConnection!.id } })).toMatchObject({ scopes: ['read_products'] });
  });
});
