import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { checkoutProofHash } from '../../../src/modules/conversion-delivery/checkout-proof.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import { conversionSignalHealth } from '../../../src/modules/conversion-delivery/signal-diagnostics.js';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.shopifyConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});
async function fixture() {
  const now = new Date();
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: unique,
      myshopifyDomain: `${unique}.myshopify.com`,
      name: 'Recovery test',
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  const connection = await prisma.shopifyConnection.create({
    data: {
      storeId: store.id,
      status: 'ACTIVE',
      apiVersion: '2026-07',
      scopes: ['read_orders', 'read_customer_events'],
      accessTokenCiphertext: 'test',
      installedAt: new Date(now.getTime() - 86400_000),
    },
  });
  const proof = checkoutProofHash(store.id, 'real-checkout-token');
  const order = await prisma.order.create({
    data: {
      storeId: store.id,
      shopifyOrderId: 'gid://shopify/Order/1001',
      name: '#1001',
      shopifyCreatedAt: now,
      currencyCode: 'USD',
      currentTotalAmount: '15',
      checkoutTokenHash: proof,
    },
  });
  const source = await prisma.storefrontEvent.create({
    data: {
      storeId: store.id,
      eventId: unique,
      eventName: 'BEGIN_CHECKOUT',
      eventAt: now,
      anonymousVisitorId: unique,
      sessionId: unique,
      adSharingAllowed: true,
      utmSource: 'meta',
      utmMedium: 'paid_social',
      consentState: 'GRANTED',
      checkoutTokenHash: proof,
      shopifyCheckoutToken: 'real-checkout-token',
      pageUrl: 'https://shop.example/checkouts/checkout',
      browserMatchCiphertext: encryptSecret(
        JSON.stringify({ clientIp: '8.8.4.4', clientIpSource: 'COLLECTOR', userAgent: 'Browser' }),
      ),
      browserMatchExpiresAt: new Date(now.getTime() + 86400_000),
      retentionExpiresAt: new Date(now.getTime() + 86400_000),
    },
  });
  const destination = await prisma.conversionDestination.create({
    data: {
      storeId: store.id,
      provider: 'META',
      externalId: unique,
      status: 'ACTIVE',
      accessTokenCiphertext: 'test',
      configJson: { enhancedMatching: false },
    },
  });
  const claim = {
    storeId: store.id,
    sourceOrderId: order.id,
    sourceEventId: source.id,
    sourceGenerationAt: connection.installedAt,
    provider: 'META' as const,
    destinationId: destination.id,
    clickId: null,
    eventName: 'PURCHASE',
    match: { clientIp: '8.8.4.4', clientIpSource: 'COLLECTOR', userAgent: 'Browser' },
  };
  return {
    store,
    order,
    source,
    destination,
    claim,
    repo: new ConversionDeliveryRepository(),
    now,
  };
}
suite('canonical purchase recovery without materialized sessions', () => {
  it('recovers a consented checkout and permits observed network context without enhanced customer reads', async () => {
    const { store, order, source, claim, repo } = await fixture();
    expect(await prisma.storefrontSession.count({ where: { storeId: store.id } })).toBe(0);
    expect(await repo.findPurchaseCandidates(10, order.id)).toMatchObject([
      {
        sourceEventId: source.id,
        orderId: order.id,
        browserMatchAvailable: true,
        metaClickId: null,
      },
    ]);
    expect(await repo.hasAdvertisingConsent(claim)).toBe(true);
    expect(await repo.hasAdvertisingConsent({ ...claim, storeId: randomUUID() })).toBe(false);
  });
  it('rejects forged checkout links and does not infer consent from order existence', async () => {
    const { store, order, source, claim, repo } = await fixture();
    await prisma.storefrontEvent.update({
      where: { id: source.id },
      data: { checkoutTokenHash: checkoutProofHash(store.id, 'wrong-token') },
    });
    expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
    expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
  });
  it('blocks withdrawal and later denied permission even without a session row', async () => {
    const { store, order, source, claim, repo, now } = await fixture();
    await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: randomUUID(),
        eventName: 'PAGE_VIEW',
        anonymousVisitorId: source.anonymousVisitorId,
        eventAt: new Date(now.getTime() + 1000),
        consentState: 'GRANTED',
        adSharingAllowed: false,
        retentionExpiresAt: new Date(now.getTime() + 86400_000),
      },
    });
    expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
    expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
  });
  it('keeps test purchases out of the live sweep, list and reconciliation', async () => {
    const { store, order, source, destination, repo } = await fixture();
    await prisma.order.update({ where: { id: order.id }, data: { isTest: true } });
    expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
    expect(await repo.findPurchaseCandidates(10, order.id, true, store.id)).toHaveLength(1);
    const input = {
      storeId: store.id,
      destinationId: destination.id,
      provider: 'META' as const,
      eventKey: 'test-order-event',
      sourceOrderId: order.id,
      sourceEventId: source.id,
      shopifyOrderId: order.shopifyOrderId,
      eventAt: new Date(),
      value: '15',
      currencyCode: 'USD',
      clickId: null,
      attributionEventAt: null,
      eventSourceUrl: source.pageUrl,
      isTestDelivery: true,
    };
    expect(await repo.enqueue(input)).toEqual({ created: true });
    expect(await repo.enqueue(input)).toEqual({ created: false });
    expect(await repo.listDeliveries(store.id, { limit: 20 })).toEqual([]);
    const health = await conversionSignalHealth(store.id);
    expect(health.providers.find((p) => p.provider === 'META')?.purchases).toMatchObject({
      orders: 0,
      accepted: 0,
    });
    expect(health.providers.find((p) => p.provider === 'META')?.facts).toEqual([]);
  });
});
