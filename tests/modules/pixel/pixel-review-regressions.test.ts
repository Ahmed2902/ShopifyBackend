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

async function createEvent(
  storeId: string,
  sessionId: string,
  input: { metaCampaignExternalId?: string; productExternalId?: string } = {},
) {
  return prisma.storefrontEvent.create({ data: {
    storeId,
    sessionId,
    eventId: randomUUID(),
    eventName: input.productExternalId ? 'PRODUCT_VIEW' : 'PAGE_VIEW',
    eventAt: new Date(),
    consentState: 'GRANTED',
    metaCampaignExternalId: input.metaCampaignExternalId ?? null,
    productExternalId: input.productExternalId ?? null,
    retentionExpiresAt: new Date(Date.now() + 86_400_000),
  } });
}

async function createMaterializedSession(
  storeId: string,
  browserSessionId: string,
  sourceReceivedAt: Date,
) {
  return prisma.storefrontSession.create({ data: {
    storeId,
    browserSessionId,
    startedAt: sourceReceivedAt,
    endedAt: sourceReceivedAt,
    lastSourceReceivedAt: sourceReceivedAt,
    eventCount: 1,
    retentionExpiresAt: new Date(sourceReceivedAt.getTime() + 86_400_000),
  } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const storeId of stores.splice(0)) {
    await prisma.metaAd.deleteMany({ where: { adAccount: { storeId } } });
    await prisma.metaAdSet.deleteMany({ where: { adAccount: { storeId } } });
    await prisma.metaCreative.deleteMany({ where: { adAccount: { storeId } } });
    await prisma.metaCampaign.deleteMany({ where: { adAccount: { storeId } } });
    await prisma.metaAdAccount.deleteMany({ where: { storeId } });
    await prisma.metaConnection.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('Pixel review regression cases', () => {
  it('keeps earlier Meta writes repairable after a later write fails, and rolls back resolver changes on enqueue failure', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({ data: {
      storeId: store.id, accessTokenCiphertext: 'test', apiVersion: 'v26.0',
    } });
    const account = await prisma.metaAdAccount.create({ data: {
      storeId: store.id, metaConnectionId: connection.id, metaAccountId: 'act_100',
      name: 'Account', currency: 'USD',
    } });
    const sessionId = randomUUID();
    const event = await createEvent(store.id, sessionId, { metaCampaignExternalId: '1001' });
    const session = await createMaterializedSession(store.id, sessionId, event.receivedAt);
    await prisma.storefrontSessionTouch.create({ data: {
      sessionId: session.id,
      ordinal: 0,
      eventAt: event.eventAt,
      source: 'META',
      metaCampaignExternalId: '1001',
      metaResolutionStatus: 'UNRESOLVED',
    } });

    const repository = new MetaAdsRepository();
    const campaign = await repository.upsertCampaign(account.id, { id: '1001', name: 'Committed' });
    await expect(repository.upsertAdSet(account.id, randomUUID(), {
      id: '2001', campaign_id: 'missing', name: 'Invalid parent',
    })).rejects.toThrow();
    const key = { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } };
    const marker = await prisma.storefrontSessionRepair.findUniqueOrThrow({ where: key });
    expect(await prisma.metaCampaign.findUnique({ where: { id: campaign.id } }))
      .toMatchObject({ name: 'Committed' });

    const deletedAt = new Date('2026-09-13T00:00:00.000Z');
    await prisma.metaCampaign.update({ where: { id: campaign.id }, data: { deletedAt } });
    vi.spyOn(invalidation, 'enqueueMetaHierarchyPixelRepairs').mockRejectedValueOnce(new Error('repair unavailable'));
    await expect(repository.upsertCampaign(account.id, { id: '1001', name: 'Must roll back' }))
      .rejects.toThrow('repair unavailable');
    expect(await prisma.metaCampaign.findUnique({ where: { id: campaign.id } }))
      .toMatchObject({ name: 'Committed', deletedAt });
    expect((await prisma.storefrontSessionRepair.findUniqueOrThrow({ where: key })).id).toBe(marker.id);
  });

  it('does not rotate Pixel repair generations for metadata-only Meta hierarchy refreshes', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({ data: {
      storeId: store.id, accessTokenCiphertext: 'test', apiVersion: 'v26.0',
    } });
    const account = await prisma.metaAdAccount.create({ data: {
      storeId: store.id, metaConnectionId: connection.id, metaAccountId: 'act_200',
      name: 'Account', currency: 'USD',
    } });
    const browserSessionId = randomUUID();
    const event = await createEvent(store.id, browserSessionId, { metaCampaignExternalId: '1001' });
    const session = await createMaterializedSession(store.id, browserSessionId, event.receivedAt);
    await prisma.storefrontSessionTouch.create({ data: {
      sessionId: session.id,
      ordinal: 0,
      eventAt: event.eventAt,
      source: 'META',
      metaCampaignExternalId: '1001',
      metaAdSetExternalId: '2001',
      metaAdExternalId: '3001',
      metaResolutionStatus: 'UNRESOLVED',
    } });

    const repository = new MetaAdsRepository();
    const campaign = await repository.upsertCampaign(account.id, { id: '1001', name: 'Campaign' });
    const adSet = await repository.upsertAdSet(account.id, campaign.id, {
      id: '2001', campaign_id: '1001', name: 'Ad set',
    });
    const creativeA = await repository.upsertCreative(account.id, { id: '4001', name: 'Creative A' });
    const creativeB = await repository.upsertCreative(account.id, { id: '4002', name: 'Creative B' });
    const ad = await repository.upsertAd(account.id, campaign.id, adSet.id, creativeA.id, {
      id: '3001', campaign_id: '1001', adset_id: '2001', name: 'Ad',
    });

    const key = { storeId_browserSessionId: { storeId: store.id, browserSessionId } };
    const before = await prisma.storefrontSessionRepair.findUniqueOrThrow({ where: key });

    await repository.upsertCampaign(account.id, {
      id: '1001', name: 'Campaign renamed', status: 'PAUSED', daily_budget: '5000',
    });
    await repository.upsertAdSet(account.id, campaign.id, {
      id: '2001', campaign_id: '1001', name: 'Ad set renamed', status: 'PAUSED', daily_budget: '2500',
    });
    await repository.upsertAd(account.id, campaign.id, adSet.id, creativeB.id, {
      id: '3001', campaign_id: '1001', adset_id: '2001', name: 'Ad renamed', status: 'PAUSED',
    });

    const after = await prisma.storefrontSessionRepair.findUniqueOrThrow({ where: key });
    expect(after.id).toBe(before.id);
    expect(await prisma.metaAd.findUniqueOrThrow({ where: { id: ad.id } })).toMatchObject({
      name: 'Ad renamed',
      creativeId: creativeB.id,
    });
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
    const productExternalId = 'gid://shopify/Product/1002';
    const browserSessionId = randomUUID();
    const event = await createEvent(store.id, browserSessionId, { productExternalId });
    const session = await createMaterializedSession(store.id, browserSessionId, event.receivedAt);
    await prisma.storefrontSessionProduct.create({ data: {
      sessionId: session.id,
      identityKey: `product:${productExternalId}`,
      shopifyProductExternalId: productExternalId,
      resolutionStatus: 'UNRESOLVED',
      viewCount: 1,
      firstSeenAt: event.eventAt,
      lastSeenAt: event.eventAt,
    } });

    const existing = await prisma.product.create({ data: {
      storeId: store.id, shopifyProductId: 'gid://shopify/Product/1001', title: 'Existing', status: 'ACTIVE',
    } });
    const product = { id: productExternalId, title: 'New', status: 'ACTIVE', tags: [], tracksInventory: false };
    await expect(new ShopifyCatalogRepository().persistProducts(store.id, [
      product, { ...product, id: existing.shopifyProductId, updatedAt: 'invalid-date' },
    ])).rejects.toThrow();
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(1);
    expect(await prisma.storefrontSessionRepair.count({ where: { storeId: store.id } })).toBe(0);
    await new ShopifyCatalogRepository().persistProducts(store.id, [product]);
    expect(await prisma.storefrontSessionRepair.count({ where: { storeId: store.id } })).toBe(1);
  });

  it('rolls back missing-catalog deletion when its repair generation cannot commit', async () => {
    const store = await createStore();
    const productExternalId = `gid://shopify/Product/${Date.now()}`;
    const product = await prisma.product.create({ data: {
      storeId: store.id,
      shopifyProductId: productExternalId,
      title: 'Must survive failed invalidation',
      status: 'ACTIVE',
    } });
    const sourceReceivedAt = new Date('2026-09-05T12:00:00.000Z');
    const browserSessionId = randomUUID();
    const session = await createMaterializedSession(store.id, browserSessionId, sourceReceivedAt);
    await prisma.storefrontSessionProduct.create({ data: {
      sessionId: session.id,
      identityKey: `product:${productExternalId}`,
      shopifyProductExternalId: productExternalId,
      productId: product.id,
      resolutionStatus: 'EXACT',
      viewCount: 1,
      firstSeenAt: sourceReceivedAt,
      lastSeenAt: sourceReceivedAt,
    } });

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `fail_pixel_repair_${suffix}`;
    const triggerName = `fail_pixel_repair_${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."storeId" = '${store.id}'::uuid THEN
          RAISE EXCEPTION 'forced repair failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT OR UPDATE ON "StorefrontSessionRepair"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    try {
      await expect(new ShopifyCatalogRepository().markMissingCatalogDeleted(store.id, [], []))
        .rejects.toThrow();
      expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .toMatchObject({ deletedAt: null });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "StorefrontSessionRepair"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }

    await expect(new ShopifyCatalogRepository().markMissingCatalogDeleted(store.id, [], []))
      .resolves.toEqual({ products: 1, variants: 0 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).deletedAt)
      .toBeInstanceOf(Date);
    expect(await prisma.storefrontSessionRepair.findUnique({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId } },
    })).not.toBeNull();
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
