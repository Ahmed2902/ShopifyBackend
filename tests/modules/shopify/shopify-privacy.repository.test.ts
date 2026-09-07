import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyPrivacyRepository } from '../../../src/modules/shopify/privacy/shopify-privacy.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

async function createBaseStore(label: string) {
  const unique = randomUUID();
  return prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: `${label} Store`,
      myshopifyDomain: `${label.toLowerCase()}-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: 'shopify-token',
          scopes: ['read_orders'],
          apiVersion: '2026-07',
        },
      },
    },
    select: {
      id: true,
      shopifyConnection: { select: { id: true } },
    },
  });
}

describeDatabase('ShopifyPrivacyRepository', () => {
  it('erases customer-linked orders, raw pixel evidence and prior data-request exports', async () => {
    const repository = new ShopifyPrivacyRepository();
    const store = await createBaseStore('privacy-customer');
    const connectionId = store.shopifyConnection!.id;
    const externalOrderId = 'gid://shopify/Order/789';
    const now = new Date('2026-09-06T12:00:00.000Z');

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: externalOrderId,
        name: '#1001',
        shopifyCreatedAt: now,
        currencyCode: 'USD',
        currentTotalAmount: 125,
      },
    });
    await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId: 'browser-session-1',
        startedAt: now,
        endedAt: now,
        lastSourceReceivedAt: now,
        eventCount: 1,
        retentionExpiresAt: new Date('2026-12-05T12:00:00.000Z'),
        shopifyOrderExternalId: externalOrderId,
        orderId: order.id,
        orderLinkStatus: 'LINKED',
      },
    });
    await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: 'privacy-event-1',
        eventName: 'CHECKOUT_COMPLETED',
        eventAt: now,
        receivedAt: now,
        sessionId: 'browser-session-1',
        consentState: 'GRANTED',
        shopifyOrderExternalId: externalOrderId,
        retentionExpiresAt: new Date('2026-12-05T12:00:00.000Z'),
      },
    });

    const dataRequestDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `data-request-${randomUUID()}`,
        shopifyConnectionId: connectionId,
        topic: 'customers/data_request',
        status: 'PROCESSED',
        payload: { processed: true },
      },
    });
    await repository.createDataRequestExport(store.id, dataRequestDelivery.id, [externalOrderId]);

    const redactDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `customer-redact-${randomUUID()}`,
        shopifyConnectionId: connectionId,
        topic: 'customers/redact',
        status: 'PROCESSING',
        payload: { orders_to_redact: [externalOrderId] },
      },
    });

    const result = await repository.redactCustomerOrders(
      store.id,
      redactDelivery.id,
      [externalOrderId],
    );

    expect(result).toEqual({ ordersDeleted: 1, sessionsDeleted: 1, eventsDeleted: 1 });
    expect(await prisma.order.findUnique({ where: { id: order.id } })).toBeNull();
    expect(
      await prisma.storefrontSession.findFirst({ where: { storeId: store.id } }),
    ).toBeNull();
    expect(await prisma.storefrontEvent.findFirst({ where: { storeId: store.id } })).toBeNull();
    expect(await prisma.shopifyDataRequest.findFirst({ where: { storeId: store.id } })).toBeNull();

    const scrubbed = await prisma.webhookDelivery.findUnique({ where: { id: redactDelivery.id } });
    expect(scrubbed?.payload).toMatchObject({
      complianceTopic: 'customers/redact',
      processed: true,
      ordersDeleted: 1,
    });

    await prisma.webhookDelivery.deleteMany({ where: { shopifyConnectionId: connectionId } });
    await prisma.shopifyConnection.delete({ where: { id: connectionId } });
    await prisma.store.delete({ where: { id: store.id } });
  });

  it('purges Shopify, Meta, TikTok, Pixel and integration rows while retaining only a scrubbed shop-redact audit', async () => {
    const repository = new ShopifyPrivacyRepository();
    const store = await createBaseStore('privacy-shop');
    const shopifyConnectionId = store.shopifyConnection!.id;
    const now = new Date('2026-09-06T12:00:00.000Z');

    const metaConnection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        status: 'ACTIVE',
        accessTokenCiphertext: 'meta-token',
        scopes: ['ads_read'],
        apiVersion: 'v26.0',
      },
    });
    const adAccount = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: metaConnection.id,
        metaAccountId: `act_${randomUUID()}`,
        name: 'Privacy Meta Account',
        currency: 'USD',
      },
    });
    const campaign = await prisma.metaCampaign.create({
      data: {
        adAccountId: adAccount.id,
        metaCampaignId: `campaign-${randomUUID()}`,
        name: 'Privacy Campaign',
      },
    });
    const adSet = await prisma.metaAdSet.create({
      data: {
        adAccountId: adAccount.id,
        campaignId: campaign.id,
        metaAdSetId: `adset-${randomUUID()}`,
        name: 'Privacy Ad Set',
      },
    });
    const ad = await prisma.metaAd.create({
      data: {
        adAccountId: adAccount.id,
        campaignId: campaign.id,
        adSetId: adSet.id,
        metaAdId: `ad-${randomUUID()}`,
        name: 'Privacy Ad',
      },
    });
    await prisma.metaInsightDaily.create({
      data: {
        insightKey: `insight-${randomUUID()}`,
        adAccountId: adAccount.id,
        campaignId: campaign.id,
        adSetId: adSet.id,
        adId: ad.id,
        level: 'AD',
        date: now,
        accountCurrency: 'USD',
      },
    });

    const tiktokConnection = await prisma.tikTokConnection.create({
      data: {
        storeId: store.id,
        status: 'ACTIVE',
        accessTokenCiphertext: 'tiktok-token',
        scopes: [],
        apiVersion: 'v1.3',
      },
    });
    const advertiser = await prisma.tikTokAdvertiser.create({
      data: {
        storeId: store.id,
        tiktokConnectionId: tiktokConnection.id,
        advertiserId: `advertiser-${randomUUID()}`,
        name: 'Privacy Advertiser',
      },
    });
    const tikTokCampaign = await prisma.tikTokCampaign.create({
      data: {
        advertiserDbId: advertiser.id,
        tiktokCampaignId: `campaign-${randomUUID()}`,
        name: 'TikTok Campaign',
      },
    });
    const adGroup = await prisma.tikTokAdGroup.create({
      data: {
        advertiserDbId: advertiser.id,
        campaignId: tikTokCampaign.id,
        tiktokAdGroupId: `adgroup-${randomUUID()}`,
        name: 'TikTok Ad Group',
      },
    });
    const tikTokAd = await prisma.tikTokAd.create({
      data: {
        advertiserDbId: advertiser.id,
        campaignId: tikTokCampaign.id,
        adGroupId: adGroup.id,
        tiktokAdId: `ad-${randomUUID()}`,
        name: 'TikTok Ad',
      },
    });
    await prisma.tikTokInsightDaily.create({
      data: {
        insightKey: `tiktok-insight-${randomUUID()}`,
        advertiserDbId: advertiser.id,
        campaignId: tikTokCampaign.id,
        adGroupId: adGroup.id,
        adId: tikTokAd.id,
        level: 'AD',
        date: now,
      },
    });

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        shopifyProductId: `gid://shopify/Product/${randomUUID()}`,
        title: 'Privacy Product',
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.productVariant.create({
      data: {
        storeId: store.id,
        productId: product.id,
        shopifyVariantId: `gid://shopify/ProductVariant/${randomUUID()}`,
        title: 'Default',
      },
    });
    const location = await prisma.location.create({
      data: {
        storeId: store.id,
        shopifyLocationId: `gid://shopify/Location/${randomUUID()}`,
        name: 'Privacy Location',
      },
    });
    const inventoryItem = await prisma.inventoryItem.create({
      data: {
        storeId: store.id,
        variantId: variant.id,
        shopifyInventoryItemId: `gid://shopify/InventoryItem/${randomUUID()}`,
      },
    });
    await prisma.inventoryLevelCurrent.create({
      data: { inventoryItemId: inventoryItem.id, locationId: location.id, available: 4 },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: `gid://shopify/Order/${randomUUID()}`,
        name: '#2001',
        shopifyCreatedAt: now,
        currencyCode: 'USD',
      },
    });
    await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: `event-${randomUUID()}`,
        eventName: 'PAGE_VIEW',
        eventAt: now,
        consentState: 'GRANTED',
        retentionExpiresAt: new Date('2026-12-05T12:00:00.000Z'),
      },
    });

    const syncRun = await prisma.syncRun.create({
      data: {
        provider: 'SHOPIFY',
        shopifyConnectionId,
        resourceType: 'PrivacyFixture',
        apiVersion: '2026-07',
        status: 'SUCCEEDED',
      },
    });
    const oldDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `old-${randomUUID()}`,
        shopifyConnectionId,
        topic: 'products/update',
        status: 'PROCESSED',
        payload: { id: 'provider-data' },
      },
    });
    const redactDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `shop-redact-${randomUUID()}`,
        shopifyConnectionId,
        topic: 'shop/redact',
        status: 'PROCESSING',
        payload: { shop_domain: 'sensitive-merchant-state' },
      },
    });
    const externalPayload = await prisma.externalPayload.create({
      data: {
        provider: 'SHOPIFY',
        resourceType: 'PrivacyFixture',
        apiVersion: '2026-07',
        payload: { raw: 'provider-data' },
        syncRunId: syncRun.id,
        webhookDeliveryId: oldDelivery.id,
      },
    });

    expect(await repository.purgeStore(store.id, redactDelivery.id)).toBe(true);

    expect(await prisma.store.findUnique({ where: { id: store.id } })).toBeNull();
    expect(await prisma.shopifyConnection.findUnique({ where: { id: shopifyConnectionId } })).toBeNull();
    expect(await prisma.metaConnection.findUnique({ where: { id: metaConnection.id } })).toBeNull();
    expect(await prisma.tikTokConnection.findUnique({ where: { id: tiktokConnection.id } })).toBeNull();
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toBeNull();
    expect(await prisma.order.findUnique({ where: { id: order.id } })).toBeNull();
    expect(await prisma.storefrontEvent.findFirst({ where: { storeId: store.id } })).toBeNull();
    expect(await prisma.externalPayload.findUnique({ where: { id: externalPayload.id } })).toBeNull();
    expect(await prisma.webhookDelivery.findUnique({ where: { id: oldDelivery.id } })).toBeNull();

    const audit = await prisma.webhookDelivery.findUnique({ where: { id: redactDelivery.id } });
    expect(audit?.shopifyConnectionId).toBeNull();
    expect(audit?.payload).toEqual({ complianceTopic: 'shop/redact', processed: true });

    await prisma.webhookDelivery.delete({ where: { id: redactDelivery.id } });
  });
});
