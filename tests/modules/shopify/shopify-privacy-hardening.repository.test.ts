import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyPrivacyRepository } from '../../../src/modules/shopify/privacy/shopify-privacy.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createConnectedStore(label: string) {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: `${label} Store`,
      myshopifyDomain: `${label}-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: 'test-token',
          scopes: ['read_orders'],
          apiVersion: '2026-07',
        },
      },
    },
    select: { id: true, shopifyConnection: { select: { id: true } } },
  });
  createdStoreIds.push(store.id);
  return store;
}

async function cleanupStore(storeId: string) {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((order) => order.id);
  if (orderIds.length > 0) {
    const refunds = await prisma.refund.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    const refundIds = refunds.map((refund) => refund.id);
    if (refundIds.length > 0) {
      await prisma.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
      await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
    }
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }

  const connection = await prisma.shopifyConnection.findUnique({
    where: { storeId },
    select: { id: true },
  });
  if (connection) {
    await prisma.shopifyDataRequest.deleteMany({ where: { storeId } });
    await prisma.webhookDelivery.deleteMany({ where: { shopifyConnectionId: connection.id } });
    await prisma.shopifyConnection.delete({ where: { id: connection.id } });
  }
  await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) await cleanupStore(storeId);
});

describeDatabase('Shopify privacy hardening', () => {
  it('redacts an unmaterialized browser session, scrubs historical webhook PII, and leaves a tombstone', async () => {
    const repository = new ShopifyPrivacyRepository();
    const store = await createConnectedStore('privacy-hardening-redact');
    const connectionId = store.shopifyConnection!.id;
    const orderId = 'gid://shopify/Order/789';
    const now = new Date('2026-09-06T12:00:00.000Z');
    const expiresAt = new Date('2026-12-05T12:00:00.000Z');

    await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: orderId,
        name: '#789',
        shopifyCreatedAt: now,
        currencyCode: 'USD',
      },
    });

    await prisma.storefrontEvent.createMany({
      data: [
        {
          storeId: store.id,
          eventId: `checkout-${randomUUID()}`,
          eventName: 'CHECKOUT_COMPLETED',
          eventAt: now,
          receivedAt: now,
          sessionId: 'raw-session-789',
          consentState: 'GRANTED',
          shopifyOrderExternalId: orderId,
          retentionExpiresAt: expiresAt,
        },
        {
          storeId: store.id,
          eventId: `page-${randomUUID()}`,
          eventName: 'PAGE_VIEW',
          eventAt: new Date(now.getTime() - 30_000),
          receivedAt: now,
          sessionId: 'raw-session-789',
          consentState: 'GRANTED',
          retentionExpiresAt: expiresAt,
        },
      ],
    });
    await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId: 'raw-session-789',
        sourceReceivedAt: now,
      },
    });

    const historicalDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `order-webhook-${randomUUID()}`,
        shopifyConnectionId: connectionId,
        topic: 'orders/updated',
        status: 'PROCESSED',
        payload: {
          id: 789,
          admin_graphql_api_id: orderId,
          email: 'customer@example.com',
          billing_address: { phone: '+15551234567' },
        },
      },
    });
    const redactDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `redact-${randomUUID()}`,
        shopifyConnectionId: connectionId,
        topic: 'customers/redact',
        status: 'PROCESSING',
        payload: { orders_to_redact: [orderId] },
      },
    });

    await prisma.storefrontConsentWithdrawal.create({ data: { storeId: store.id, scopeKey: 'session:raw-session-789', revokedBefore: now, retentionExpiresAt: expiresAt } });
    await repository.redactCustomerOrders(store.id, redactDelivery.id, [orderId]);
    expect(await prisma.storefrontConsentWithdrawal.count({ where: { storeId: store.id } })).toBe(1);

    expect(await prisma.storefrontEvent.count({ where: { storeId: store.id } })).toBe(0);
    expect(await prisma.storefrontSessionRepair.count({ where: { storeId: store.id } })).toBe(0);
    expect(
      await prisma.shopifyOrderRedaction.findUnique({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: orderId } },
      }),
    ).not.toBeNull();

    const scrubbed = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: historicalDelivery.id },
      select: { payload: true },
    });
    expect(scrubbed.payload).toEqual({ redacted: true, reason: 'customers/redact' });
    expect(JSON.stringify(scrubbed.payload)).not.toContain('customer@example.com');
    expect(JSON.stringify(scrubbed.payload)).not.toContain('+15551234567');
    // A delayed pre-withdrawal batch arrives after customer redaction. The connection date
    // deliberately allows the event, so only the retained withdrawal barrier can downgrade it.
    await prisma.shopifyConnection.update({ where: { id: connectionId }, data: { installedAt: new Date(now.getTime() - 60_000) } });
    await new PixelRepository().insertEvents(store.id, [{
      eventId: 'delayed-after-redaction', eventName: 'PAGE_VIEW', eventAt: new Date(now.getTime() - 1000),
      receivedAt: now, sessionId: 'raw-session-789', consentState: 'GRANTED', adSharingAllowed: true,
      browserMatchCiphertext: 'must-not-survive', browserMatchExpiresAt: expiresAt, retentionExpiresAt: expiresAt,
    }], now);
    const delayed = await prisma.storefrontEvent.findFirstOrThrow({ where: { storeId: store.id, eventId: 'delayed-after-redaction' } });
    expect(delayed.adSharingAllowed).toBe(false);
    expect(delayed.browserMatchCiphertext).toBeNull();

  });

  it('exports all retained order, raw-event, materialized-session, and historical webhook evidence', async () => {
    const repository = new ShopifyPrivacyRepository();
    const store = await createConnectedStore('privacy-hardening-access');
    const connectionId = store.shopifyConnection!.id;
    const orderId = 'gid://shopify/Order/990';
    const now = new Date('2026-09-06T13:00:00.000Z');
    const expiresAt = new Date('2026-12-05T13:00:00.000Z');

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        shopifyOrderId: orderId,
        name: '#990',
        shopifyCreatedAt: now,
        currencyCode: 'USD',
        customerOrderIndex: 3,
        daysToConversion: 2,
        customerJourneyReady: true,
        rawJson: { retainedJourneyField: 'yes' },
      },
    });
    const session = await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId: 'access-session-990',
        anonymousVisitorId: 'visitor-990',
        startedAt: now,
        endedAt: now,
        lastSourceReceivedAt: now,
        eventCount: 2,
        retentionExpiresAt: expiresAt,
        shopifyOrderExternalId: orderId,
        orderId: order.id,
        orderLinkStatus: 'LINKED',
      },
    });
    await prisma.storefrontSessionProduct.create({
      data: {
        sessionId: session.id,
        identityKey: 'product:gid://shopify/Product/55',
        shopifyProductExternalId: 'gid://shopify/Product/55',
        viewCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    await prisma.storefrontSessionCollection.create({
      data: {
        sessionId: session.id,
        shopifyCollectionExternalId: 'gid://shopify/Collection/66',
        viewCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    const accessEvent = await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: `access-event-${randomUUID()}`,
        eventName: 'CHECKOUT_COMPLETED',
        eventAt: now,
        receivedAt: now,
        sessionId: 'access-session-990',
        anonymousVisitorId: 'visitor-990',
        consentState: 'GRANTED',
        shopifyOrderExternalId: orderId,
        metaClickId: 'fbclid-990',
        retentionExpiresAt: expiresAt,
      },
    });
    await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `access-order-webhook-${randomUUID()}`,
        shopifyConnectionId: connectionId,
        topic: 'orders/create',
        status: 'PROCESSED',
        payload: { id: 990, admin_graphql_api_id: orderId, email: 'retained@example.com' },
      },
    });
    const requestDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `access-request-${randomUUID()}`,
        shopifyConnectionId: connectionId,
        topic: 'customers/data_request',
        status: 'PROCESSING',
        payload: { orders_requested: [orderId] },
      },
    });

    await prisma.storefrontConsentWithdrawal.createMany({ data: ['session:access-session-990', 'visitor:visitor-990'].map(scopeKey => ({ storeId: store.id, scopeKey, revokedBefore: now, retentionExpiresAt: expiresAt })) });

    await prisma.storefrontCustomerLink.create({ data: { storeId: store.id, sourceOrderId: order.id, customerKey: 'a'.repeat(64), expiresAt } });
    const destination = await prisma.conversionDestination.create({ data: { storeId: store.id, provider: 'META', externalId: 'privacy-export-destination', accessTokenCiphertext: 'never-export-provider-token' } });
    const delivery = await prisma.conversionDelivery.create({ data: { storeId: store.id, destinationId: destination.id, provider: 'META', eventKey: 'export-purchase', eventName: 'PURCHASE', sourceOrderId: order.id, shopifyOrderId: orderId, eventAt: now, clickId: 'retained-click-id', eventSourceUrl: 'https://shop.test/products/example' } });
    await prisma.conversionDelivery.create({ data: { storeId: store.id, destinationId: destination.id, provider: 'META', eventKey: 'export-event', eventName: 'PRODUCT_VIEW', sourceEventId: accessEvent.id, eventAt: now } });
    const foreign = await createConnectedStore('privacy-foreign');
    const foreignOrder = await prisma.order.create({ data: { storeId: foreign.id, shopifyOrderId: orderId, name: '#foreign', shopifyCreatedAt: now, currencyCode: 'USD' } });
    await prisma.storefrontCustomerLink.create({ data: { storeId: foreign.id, sourceOrderId: foreignOrder.id, customerKey: 'b'.repeat(64), expiresAt } });
    const foreignDestination = await prisma.conversionDestination.create({ data: { storeId: foreign.id, provider: 'META', externalId: 'foreign-export' } });
    await prisma.conversionDelivery.create({ data: { storeId: foreign.id, destinationId: foreignDestination.id, provider: 'META', eventKey: 'foreign-export', eventName: 'PURCHASE', sourceOrderId: foreignOrder.id, shopifyOrderId: orderId, eventAt: now, clickId: 'foreign-click-id' } });
    const request = await repository.createDataRequestExport(store.id, requestDelivery.id, [orderId]);
    const exported = request.exportJson as Record<string, unknown>;
    expect(exported.storefrontConsentWithdrawals).toMatchObject([{ scopeKey: 'session:access-session-990' }, { scopeKey: 'visitor:visitor-990' }]);
    expect(exported.storefrontCustomerLinks).toMatchObject([{ sourceOrderId: order.id, customerKey: 'a'.repeat(64) }]);
    expect(exported.conversionDeliveries).toEqual(expect.arrayContaining([expect.objectContaining({ id: delivery.id, clickId: 'retained-click-id', eventSourceUrl: 'https://shop.test/products/example' })]));
    expect(exported.conversionDeliveries).toHaveLength(2);
    expect(exported.conversionDeliveries).toEqual(expect.arrayContaining([expect.objectContaining({ sourceEventId: accessEvent.id })]));
    expect(JSON.stringify(exported)).not.toContain('foreign-click-id');
    expect(JSON.stringify(exported)).not.toContain('never-export-provider-token');
    expect(JSON.stringify(exported)).not.toContain('b'.repeat(64));
    const exportedOrders = exported.orders as Array<Record<string, unknown>>;
    const exportedSessions = exported.storefrontSessions as Array<Record<string, unknown>>;
    const exportedEvents = exported.storefrontEvents as Array<Record<string, unknown>>;
    const exportedDeliveries = exported.historicalShopifyWebhookDeliveries as Array<
      Record<string, unknown>
    >;

    expect(exportedOrders[0]).toMatchObject({
      shopifyOrderId: orderId,
      customerOrderIndex: 3,
      daysToConversion: 2,
      customerJourneyReady: true,
      rawJson: { retainedJourneyField: 'yes' },
    });
    expect(exportedSessions[0]?.products).toHaveLength(1);
    expect(exportedSessions[0]?.collections).toHaveLength(1);
    expect(exportedEvents[0]).toMatchObject({
      shopifyOrderExternalId: orderId,
      metaClickId: 'fbclid-990',
    });
    expect(exportedDeliveries[0]?.payload).toMatchObject({ email: 'retained@example.com' });
  });
});
