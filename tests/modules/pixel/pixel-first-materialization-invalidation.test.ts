import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';
import { ShopifyCatalogRepository } from '../../../src/modules/shopify/catalog/shopify-catalog.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Pixel first-materialization store',
      myshopifyDomain: `pixel-first-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  return store;
}

async function createOutstandingRepair(
  storeId: string,
  browserSessionId: string,
  input: { metaCampaignExternalId?: string; productExternalId?: string },
) {
  const event = await prisma.storefrontEvent.create({
    data: {
      storeId,
      sessionId: browserSessionId,
      eventId: randomUUID(),
      eventName: input.productExternalId ? 'PRODUCT_VIEW' : 'PAGE_VIEW',
      eventAt: new Date(),
      consentState: 'GRANTED',
      metaCampaignExternalId: input.metaCampaignExternalId ?? null,
      productExternalId: input.productExternalId ?? null,
      retentionExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return prisma.storefrontSessionRepair.create({
    data: {
      storeId,
      browserSessionId,
      sourceReceivedAt: event.receivedAt,
    },
  });
}

async function cleanupStore(storeId: string) {
  await prisma.storefrontSessionTouch.deleteMany({ where: { session: { storeId } } });
  await prisma.storefrontSessionProduct.deleteMany({ where: { session: { storeId } } });
  await prisma.storefrontSessionCollection.deleteMany({ where: { session: { storeId } } });
  await prisma.storefrontSessionRepair.deleteMany({ where: { storeId } });
  await prisma.storefrontEvent.deleteMany({ where: { storeId } });
  await prisma.storefrontSession.deleteMany({ where: { storeId } });
  await prisma.metaAd.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaAdSet.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaCampaign.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaCreative.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaAdAccount.deleteMany({ where: { storeId } });
  await prisma.metaConnection.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await cleanupStore(storeId);
  }
});

describeDatabase('Pixel source invalidation during first materialization', () => {
  it('rotates a raw-only repair generation when Meta hierarchy truth changes', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        accessTokenCiphertext: 'test',
        apiVersion: 'v26.0',
      },
    });
    const account = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: connection.id,
        metaAccountId: 'act_100',
        name: 'Account',
        currency: 'USD',
      },
    });
    const browserSessionId = randomUUID();
    const before = await createOutstandingRepair(store.id, browserSessionId, {
      metaCampaignExternalId: '1001',
    });

    await new MetaAdsRepository().upsertCampaign(account.id, { id: '1001', name: 'Campaign' });

    const after = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId } },
    });
    expect(after.id).not.toBe(before.id);
    expect(await prisma.storefrontSession.count({ where: { storeId: store.id } })).toBe(0);
  });

  it('rotates a raw-only repair generation when Shopify catalog identity changes', async () => {
    const store = await createStore();
    const browserSessionId = randomUUID();
    const productExternalId = 'gid://shopify/Product/1001';
    const before = await createOutstandingRepair(store.id, browserSessionId, { productExternalId });

    await new ShopifyCatalogRepository().persistProducts(store.id, [
      {
        id: productExternalId,
        title: 'Product',
        status: 'ACTIVE',
        tags: [],
        tracksInventory: false,
      },
    ]);

    const after = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId } },
    });
    expect(after.id).not.toBe(before.id);
    expect(await prisma.storefrontSession.count({ where: { storeId: store.id } })).toBe(0);
  });

  it('invalidates an ad-only materialized touch when its resolved ad set is reparented', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        accessTokenCiphertext: 'test',
        apiVersion: 'v26.0',
      },
    });
    const account = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: connection.id,
        metaAccountId: 'act_200',
        name: 'Account',
        currency: 'USD',
      },
    });
    const repository = new MetaAdsRepository();
    const campaignA = await repository.upsertCampaign(account.id, { id: '2001', name: 'A' });
    const campaignB = await repository.upsertCampaign(account.id, { id: '2002', name: 'B' });
    const adSet = await repository.upsertAdSet(account.id, campaignA.id, {
      id: '2101',
      campaign_id: '2001',
      name: 'Set',
    });
    const ad = await repository.upsertAd(account.id, campaignA.id, adSet.id, null, {
      id: '2201',
      campaign_id: '2001',
      adset_id: '2101',
      name: 'Ad',
    });

    const now = new Date();
    const session = await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId: randomUUID(),
        startedAt: now,
        endedAt: now,
        lastSourceReceivedAt: now,
        eventCount: 1,
        retentionExpiresAt: new Date(now.getTime() + 86_400_000),
      },
    });
    await prisma.storefrontSessionTouch.create({
      data: {
        sessionId: session.id,
        ordinal: 1,
        eventAt: now,
        source: 'META',
        metaAdExternalId: '2201',
        metaAdId: ad.id,
        metaAdSetId: adSet.id,
        metaCampaignId: campaignA.id,
        metaResolutionStatus: 'EXACT',
      },
    });

    await repository.upsertAdSet(account.id, campaignB.id, {
      id: '2101',
      campaign_id: '2002',
      name: 'Set',
    });

    expect(await prisma.storefrontSessionRepair.findUnique({
      where: {
        storeId_browserSessionId: {
          storeId: store.id,
          browserSessionId: session.browserSessionId,
        },
      },
    })).not.toBeNull();
  });
});