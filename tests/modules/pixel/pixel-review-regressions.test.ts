import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';
import { PixelJourneyRepository } from '../../../src/modules/pixel/journey/pixel-journey.repository.js';
import * as invalidation from '../../../src/modules/pixel/pixel-source-invalidation.js';
import { PixelRollupStateRepair } from '../../../src/modules/pixel/rollup/pixel-rollup-state-repair.js';
import { ShopifyCatalogRepository } from '../../../src/modules/shopify/catalog/shopify-catalog.repository.js';
import { ShopifyWebhookRepository } from '../../../src/modules/shopify/webhook/shopify-webhook.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({ data: {
    shopifyShopId: `gid://shopify/Shop/${suffix}`,
    name: 'Pixel regression store',
    myshopifyDomain: `regression-${suffix}.myshopify.com`,
    currencyCode: 'USD',
    ianaTimezone: 'UTC',
  } });
  stores.push(store.id);
  return store;
}

async function createEvent(storeId: string, sessionId: string) {
  return prisma.storefrontEvent.create({ data: {
    storeId, sessionId, eventId: randomUUID(), eventName: 'PAGE_VIEW',
    eventAt: new Date(), consentState: 'GRANTED', metaCampaignExternalId: '1001',
    productExternalId: 'gid://shopify/Product/1001',
    retentionExpiresAt: new Date(Date.now() + 86_400_000),
  } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const storeId of stores.splice(0)) {
    await prisma.metaCampaign.deleteMany({ where: { adAccount: { storeId } } });
    await prisma.metaAdAccount.deleteMany({ where: { storeId } });
    await prisma.metaConnection.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('Pixel review regression cases', () => {
  it('keeps earlier Meta writes repairable after a later write fails, and rolls back on enqueue failure', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({ data: {
      storeId: store.id, accessTokenCiphertext: 'test', apiVersion: 'v26.0',
    } });
    const account = await prisma.metaAdAccount.create({ data: {
      storeId: store.id, metaConnectionId: connection.id, metaAccountId: 'act_100',
      name: 'Account', currency: 'USD',
    } });
    const sessionId = randomUUID();
    await createEvent(store.id, sessionId);
    const repository = new MetaAdsRepository();
    const campaign = await repository.upsertCampaign(account.id, { id: '1001', name: 'Committed' });
    await expect(repository.upsertAdSet(account.id, randomUUID(), {
      id: '2001', campaign_id: 'missing', name: 'Invalid parent',
    })).rejects.toThrow();
    const key = { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } };
    const marker = await prisma.storefrontSessionRepair.findUniqueOrThrow({ where: key });
    expect(await prisma.metaCampaign.findUnique({ where: { id: campaign.id } }))
      .toMatchObject({ name: 'Committed' });

    vi.spyOn(invalidation, 'enqueueMetaHierarchyPixelRepairs').mockRejectedValueOnce(new Error('repair unavailable'));
    await expect(repository.upsertCampaign(account.id, { id: '1001', name: 'Must roll back' }))
      .rejects.toThrow('repair unavailable');
    expect(await prisma.metaCampaign.findUnique({ where: { id: campaign.id } }))
      .toMatchObject({ name: 'Committed' });
    expect((await prisma.storefrontSessionRepair.findUniqueOrThrow({ where: key })).id).toBe(marker.id);
  });

  it('rejects a delayed link after order deletion and repair completion, then links the replacement', async () => {
    const store = await createStore();
    const externalId = 'gid://shopify/Order/1001';
    const orderData = { storeId: store.id, shopifyOrderId: externalId, name: '#1001',
      shopifyCreatedAt: new Date(), currencyCode: 'USD' };
    const order = await prisma.order.create({ data: orderData });
    const now = new Date();
    const session = await prisma.storefrontSession.create({ data: {
      storeId: store.id, browserSessionId: randomUUID(), startedAt: now, endedAt: now,
      lastSourceReceivedAt: now, eventCount: 1, shopifyOrderExternalId: externalId,
      orderLinkStatus: 'PENDING', retentionExpiresAt: new Date(Date.now() + 86_400_000),
    } });
    await new ShopifyWebhookRepository().deleteOrder(store.id, externalId);
    // Model a repair pass finishing before the delayed linker's earlier lookup is used.
    await prisma.storefrontSessionRepair.deleteMany({ where: { storeId: store.id } });
    const repository = new PixelJourneyRepository();
    expect(await repository.setOrderLink(session.id, externalId, order.id, new Date()))
      .toEqual({ count: 0 });
    expect(await prisma.storefrontSession.findUnique({ where: { id: session.id } }))
      .toMatchObject({ orderLinkStatus: 'PENDING', orderId: null });
    const replacement = await prisma.order.create({ data: orderData });
    expect(await repository.setOrderLink(session.id, externalId, replacement.id, new Date()))
      .toEqual({ count: 1 });
  });

  it('rolls back earlier product-page inserts when a later update fails', async () => {
    const store = await createStore();
    await createEvent(store.id, randomUUID());
    const existing = await prisma.product.create({ data: {
      storeId: store.id, shopifyProductId: 'gid://shopify/Product/1001', title: 'Existing', status: 'ACTIVE',
    } });
    const product = { id: 'gid://shopify/Product/1002', title: 'New', status: 'ACTIVE', tags: [], tracksInventory: false };
    await expect(new ShopifyCatalogRepository().persistProducts(store.id, [
      product, { ...product, id: existing.shopifyProductId, updatedAt: 'invalid-date' },
    ])).rejects.toThrow();
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(1);
    expect(await prisma.storefrontSessionRepair.count({ where: { storeId: store.id } })).toBe(0);
    await new ShopifyCatalogRepository().persistProducts(store.id, [product]);
    expect(await prisma.storefrontSessionRepair.count({ where: { storeId: store.id } })).toBe(1);
  });

  it('repairs errored rollup state after the final session has been removed', async () => {
    const store = await createStore();
    const previous = new Date('2026-09-01T00:00:00Z');
    await prisma.storefrontBehaviorRollupState.create({ data: {
      storeId: store.id, lastError: 'state update failed', rolledThroughMaterializedAt: previous,
    } });
    await prisma.storefrontAttributionRollupState.create({ data: {
      storeId: store.id, lastError: 'state update failed',
    } });
    const repair = new PixelRollupStateRepair();
    await repair.repairBehavior();
    await repair.repairAttribution();
    expect(await prisma.storefrontBehaviorRollupState.findUnique({ where: { storeId: store.id } }))
      .toMatchObject({ lastError: null, rolledThroughMaterializedAt: previous });
    expect(await prisma.storefrontAttributionRollupState.findUnique({ where: { storeId: store.id } }))
      .toMatchObject({ lastError: null, rolledThroughSessionUpdatedAt: expect.any(Date) });
  });
});
