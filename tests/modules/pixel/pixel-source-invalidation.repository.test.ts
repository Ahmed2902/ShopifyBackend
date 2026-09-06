import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { ShopifyCatalogRepository } from '../../../src/modules/shopify/catalog/shopify-catalog.repository.js';
import { ShopifyWebhookRepository } from '../../../src/modules/shopify/webhook/shopify-webhook.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Pixel source invalidation test store',
      myshopifyDomain: `pixel-source-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  createdStoreIds.push(store.id);
  return store;
}

async function createMaterializedSession(storeId: string, browserSessionId: string, receivedAt: Date) {
  return prisma.storefrontSession.create({
    data: {
      storeId,
      browserSessionId,
      startedAt: receivedAt,
      endedAt: receivedAt,
      lastSourceReceivedAt: receivedAt,
      eventCount: 1,
      retentionExpiresAt: new Date(receivedAt.getTime() + 90 * 86_400_000),
    },
  });
}

afterEach(async () => {
  while (createdStoreIds.length > 0) {
    const storeId = createdStoreIds.pop()!;
    await prisma.metaConnection.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
});

describeDatabase('Pixel source-domain invalidation', () => {
  it('rotates repair generation, unlinks, and dirties sessions before deleting Shopify order truth', async () => {
    const store = await createStore();
    const shopifyOrderId = `gid://shopify/Order/${Date.now()}`;
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId,
        name: '#1001',
        shopifyCreatedAt: new Date('2026-09-01T10:00:00.000Z'),
        currencyCode: 'USD',
      },
    });
    const previousDirtyAt = new Date('2026-09-01T10:05:00.000Z');
    const browserSessionId = `session-${randomUUID()}`;
    const session = await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId,
        startedAt: new Date('2026-09-01T09:55:00.000Z'),
        endedAt: new Date('2026-09-01T10:05:00.000Z'),
        lastSourceReceivedAt: new Date('2026-09-01T10:05:00.000Z'),
        eventCount: 3,
        shopifyOrderExternalId: shopifyOrderId,
        orderId: order.id,
        orderLinkStatus: 'LINKED',
        rollupDirtyAt: previousDirtyAt,
        behaviorRolledUpAt: new Date('2026-09-01T11:00:00.000Z'),
        behaviorRolledStartedAt: new Date('2026-09-01T09:55:00.000Z'),
        attributionRolledUpAt: new Date('2026-09-01T11:00:00.000Z'),
        attributionRolledStartedAt: new Date('2026-09-01T09:55:00.000Z'),
        retentionExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    });
    const originalRepair = await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId,
        sourceReceivedAt: session.lastSourceReceivedAt,
      },
    });

    await expect(
      new ShopifyWebhookRepository().deleteOrder(store.id, shopifyOrderId),
    ).resolves.toBe(true);

    await expect(prisma.order.findUnique({ where: { id: order.id } })).resolves.toBeNull();
    const repaired = await prisma.storefrontSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(repaired.orderId).toBeNull();
    expect(repaired.orderLinkStatus).toBe('PENDING');
    expect(repaired.orderLinkAttemptCount).toBe(0);
    expect(repaired.orderLinkNextAttemptAt).not.toBeNull();
    expect(repaired.rollupDirtyAt.getTime()).toBeGreaterThan(previousDirtyAt.getTime());

    const repair = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId } },
    });
    expect(repair.id).not.toBe(originalRepair.id);
    expect(repair.sourceReceivedAt).toEqual(session.lastSourceReceivedAt);
  });

  it('rotates materialized Pixel repair generations after Meta hierarchy sync', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        metaUserId: 'meta-user',
        accessTokenCiphertext: 'ciphertext',
        scopes: ['ads_read'],
        apiVersion: 'v25.0',
      },
    });
    const sessionId = `session-meta-${randomUUID()}`;
    const receivedAt = new Date('2026-09-05T12:00:00.000Z');
    await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: `event-${randomUUID()}`,
        eventName: 'PAGE_VIEW',
        eventAt: receivedAt,
        receivedAt,
        sessionId,
        consentState: 'GRANTED',
        metaCampaignExternalId: '1001',
        metaAdSetExternalId: '2002',
        metaAdExternalId: '3003',
        retentionExpiresAt: new Date('2026-12-04T12:00:00.000Z'),
      },
    });
    const session = await createMaterializedSession(store.id, sessionId, receivedAt);
    await prisma.storefrontSessionTouch.create({
      data: {
        sessionId: session.id,
        ordinal: 0,
        eventAt: receivedAt,
        source: 'META',
        metaCampaignExternalId: '1001',
        metaAdSetExternalId: '2002',
        metaAdExternalId: '3003',
        metaResolutionStatus: 'UNRESOLVED',
      },
    });
    const originalRepair = await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId: sessionId,
        sourceReceivedAt: new Date('2026-09-05T11:00:00.000Z'),
      },
    });

    await new MetaRepository().markConnectionSynced(connection.id, new Date('2026-09-05T12:05:00.000Z'));

    const repair = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } },
    });
    expect(repair.id).not.toBe(originalRepair.id);
    expect(repair.sourceReceivedAt).toEqual(receivedAt);
  });

  it('rotates materialized Pixel repair generations after Shopify catalog resolution changes', async () => {
    const store = await createStore();
    const productExternalId = `gid://shopify/Product/${Date.now()}`;
    const sessionId = `session-shopify-${randomUUID()}`;
    const receivedAt = new Date('2026-09-05T12:10:00.000Z');
    await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: `event-${randomUUID()}`,
        eventName: 'PRODUCT_VIEW',
        eventAt: receivedAt,
        receivedAt,
        sessionId,
        consentState: 'GRANTED',
        productExternalId,
        retentionExpiresAt: new Date('2026-12-04T12:10:00.000Z'),
      },
    });
    const session = await createMaterializedSession(store.id, sessionId, receivedAt);
    await prisma.storefrontSessionProduct.create({
      data: {
        sessionId: session.id,
        identityKey: `product:${productExternalId}`,
        shopifyProductExternalId: productExternalId,
        resolutionStatus: 'UNRESOLVED',
        viewCount: 1,
        firstSeenAt: receivedAt,
        lastSeenAt: receivedAt,
      },
    });
    const originalRepair = await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId: sessionId,
        sourceReceivedAt: new Date('2026-09-05T12:00:00.000Z'),
      },
    });

    await new ShopifyCatalogRepository().enqueuePixelResolutionRepairs(
      store.id,
      productExternalId,
    );

    const repair = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } },
    });
    expect(repair.id).not.toBe(originalRepair.id);
    expect(repair.sourceReceivedAt).toEqual(receivedAt);
  });

  it('rotates the ingestion repair generation for raw-only sessions when provider truth changes', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        metaUserId: 'meta-user-raw',
        accessTokenCiphertext: 'ciphertext',
        scopes: ['ads_read'],
        apiVersion: 'v25.0',
      },
    });
    const sessionId = `raw-only-${randomUUID()}`;
    const receivedAt = new Date('2026-09-05T13:00:00.000Z');
    await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: `event-${randomUUID()}`,
        eventName: 'PAGE_VIEW',
        eventAt: receivedAt,
        receivedAt,
        sessionId,
        consentState: 'GRANTED',
        metaCampaignExternalId: 'raw-campaign',
        retentionExpiresAt: new Date('2026-12-04T13:00:00.000Z'),
      },
    });
    const originalRepair = await prisma.storefrontSessionRepair.create({
      data: { storeId: store.id, browserSessionId: sessionId, sourceReceivedAt: receivedAt },
    });

    await new MetaRepository().markConnectionSynced(connection.id, new Date('2026-09-05T13:05:00.000Z'));

    const repair = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } },
    });
    expect(repair.id).not.toBe(originalRepair.id);
    expect(repair.sourceReceivedAt).toEqual(receivedAt);
  });
});