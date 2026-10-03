import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { customerOrderJourney } from '../../../src/modules/conversion-delivery/customer-journey.js';
import { customerIdentity } from '../../../src/modules/conversion-delivery/matching.js';
const db = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await prisma.shopifyConnection.deleteMany({ where: { storeId } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});
async function fixture() {
  const unique = randomUUID();
  const now = new Date();
  const generation = new Date(now.getTime() - 3600_000);
  const store = await prisma.store.create({
    data: {
      shopifyShopId: unique,
      myshopifyDomain: `${unique}.myshopify.com`,
      name: 'Signal test',
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  await prisma.shopifyConnection.create({
    data: {
      storeId: store.id,
      accessTokenCiphertext: 'test',
      apiVersion: '2026-10',
      installedAt: generation,
      scopes: ['read_customer_events', 'read_orders'],
    },
  });
  const order = await prisma.order.create({
    data: {
      storeId: store.id,
      shopifyOrderId: `gid://shopify/Order/${Date.now()}`,
      name: '#1',
      shopifyCreatedAt: now,
      currencyCode: 'USD',
      currentTotalAmount: '10',
    },
  });
  const event = await prisma.storefrontEvent.create({
    data: {
      storeId: store.id,
      eventId: randomUUID(),
      eventName: 'CHECKOUT_COMPLETED',
      eventAt: now,
      sessionId: unique,
      anonymousVisitorId: 'same-visitor',
      consentState: 'GRANTED',
      adSharingAllowed: true,
      browserMatchCiphertext: 'encrypted',
      browserMatchExpiresAt: new Date(now.getTime() + 3600_000),
      retentionExpiresAt: new Date(now.getTime() + 86400_000),
    },
  });
  const session = await prisma.storefrontSession.create({
    data: {
      storeId: store.id,
      browserSessionId: unique,
      anonymousVisitorId: 'same-visitor',
      startedAt: now,
      endedAt: now,
      lastSourceReceivedAt: now,
      eventCount: 1,
      orderId: order.id,
      orderLinkStatus: 'LINKED',
      retentionExpiresAt: new Date(now.getTime() + 86400_000),
    },
  });
  const destination = await prisma.conversionDestination.create({
    data: {
      storeId: store.id,
      provider: 'META',
      externalId: unique,
      configJson: { enhancedMatching: true },
    },
  });
  return {
    store,
    order,
    event,
    destination,
    session,
    now,
    generation,
    claim: {
      storeId: store.id,
      provider: 'META' as const,
      destinationId: destination.id,
      sourceOrderId: order.id,
      sourceEventId: event.id,
      sourceGenerationAt: generation,
      clickId: null,
    },
  };
}
db('deterministic signal identity and lifecycle', () => {
  it('stitches exact customer orders while refusing cross-store links and destinations', async () => {
    const a = await fixture();
    const b = await fixture();
    const repo = new ConversionDeliveryRepository();
    const key = customerIdentity('secret', a.store.id, 'gid://shopify/Customer/1');
    await repo.linkCustomerIdentity({ ...a.claim, customerIdentityKey: key });
    expect((await customerOrderJourney(a.store.id, a.order.id)).orders).toHaveLength(1);
    await expect(customerOrderJourney(b.store.id, a.order.id)).rejects.toHaveProperty(
      'code',
      'CUSTOMER_JOURNEY_UNAVAILABLE',
    );
    await expect(
      prisma.storefrontCustomerLink.create({
        data: {
          sourceOrderId: b.order.id,
          storeId: a.store.id,
          customerKey: key,
          expiresAt: new Date(Date.now() + 10000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.conversionDelivery.create({
        data: {
          storeId: a.store.id,
          destinationId: b.destination.id,
          provider: 'META',
          eventKey: randomUUID(),
          eventName: 'PAGE_VIEW',
          eventAt: a.now,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.conversionDelivery.create({
        data: {
          storeId: a.store.id,
          destinationId: a.destination.id,
          provider: 'TIKTOK',
          eventKey: randomUUID(),
          eventName: 'PAGE_VIEW',
          eventAt: a.now,
        },
      }),
    ).rejects.toThrow();
  });
  it('revocation clears encrypted context and customer links; later regrant does not authorize the old claim', async () => {
    const f = await fixture();
    const repo = new ConversionDeliveryRepository();
    await repo.linkCustomerIdentity({ ...f.claim, customerIdentityKey: 'customer-key' });
    expect(await repo.hasAdvertisingConsent(f.claim)).toBe(true);
    const cutoff = new Date(f.now.getTime() + 1000);
    await new PixelRepository().withdrawAdvertisingConsent(
      f.store.id,
      { anonymousVisitorId: 'same-visitor' },
      cutoff,
      new Date(Date.now() + 40 * 86400_000),
    );
    expect(await prisma.storefrontCustomerLink.count({ where: { storeId: f.store.id } })).toBe(0);
    expect(await prisma.storefrontEvent.findUnique({ where: { id: f.event.id } })).toMatchObject({
      adSharingAllowed: false,
      browserMatchCiphertext: null,
    });
    await prisma.storefrontEvent.create({
      data: {
        storeId: f.store.id,
        sessionId: f.event.sessionId,
        anonymousVisitorId: 'same-visitor',
        eventId: randomUUID(),
        eventName: 'PAGE_VIEW',
        eventAt: new Date(cutoff.getTime() + 1000),
        consentState: 'GRANTED',
        adSharingAllowed: true,
        retentionExpiresAt: new Date(Date.now() + 86400_000),
      },
    });
    expect(await repo.hasAdvertisingConsent(f.claim)).toBe(false);
    await repo.linkCustomerIdentity({ ...f.claim, customerIdentityKey: 'customer-key' });
    expect(await prisma.storefrontCustomerLink.count({ where: { storeId: f.store.id } })).toBe(0);
  });
  it('reinstall, revoked provider settings and deleted source orders block prepared matching', async () => {
    const f = await fixture();
    const repo = new ConversionDeliveryRepository();
    expect(await repo.hasAdvertisingConsent(f.claim)).toBe(true);
    await prisma.conversionDestination.update({
      where: { id: f.destination.id },
      data: { configJson: { enhancedMatching: false } },
    });
    expect(
      await repo.hasAdvertisingConsent({ ...f.claim, match: { meta: { em: ['hash'] } } }),
    ).toBe(false);
    await prisma.shopifyConnection.update({
      where: { storeId: f.store.id },
      data: { installedAt: new Date(f.generation.getTime() + 1000) },
    });
    expect(await repo.hasAdvertisingConsent(f.claim)).toBe(false);
    await prisma.shopifyConnection.update({
      where: { storeId: f.store.id },
      data: { installedAt: f.generation, status: 'UNINSTALLED' },
    });
    expect(await repo.hasAdvertisingConsent(f.claim)).toBe(false);
  });
  it('expires browser evidence and customer links, preserving only factual diagnostics', async () => {
    const f = await fixture();
    await prisma.storefrontEvent.update({
      where: { id: f.event.id },
      data: { browserMatchExpiresAt: new Date(0) },
    });
    await prisma.storefrontCustomerLink.create({
      data: {
        storeId: f.store.id,
        sourceOrderId: f.order.id,
        customerKey: 'expired',
        expiresAt: new Date(0),
      },
    });
    await new PixelRepository().cleanupMatchEvidence(new Date(), 100);
    expect(await prisma.storefrontEvent.findUnique({ where: { id: f.event.id } })).toMatchObject({
      browserMatchCiphertext: null,
    });
    expect(await prisma.storefrontCustomerLink.count({ where: { storeId: f.store.id } })).toBe(0);
  });
});

db('identity privacy transaction races', () => {
  it('does not leave a customer link when linking races consent withdrawal', async () => {
    const f = await fixture();
    const repo = new ConversionDeliveryRepository();
    await Promise.all([
      repo.linkCustomerIdentity({ ...f.claim, customerIdentityKey: 'race-customer' }),
      new PixelRepository().withdrawAdvertisingConsent(f.store.id, { anonymousVisitorId: 'same-visitor' },
        new Date(f.now.getTime() + 1000), new Date(Date.now() + 40 * 86400_000)),
    ]);
    expect(await prisma.storefrontCustomerLink.count({ where: { storeId: f.store.id } })).toBe(0);
    expect(await repo.hasAdvertisingConsent(f.claim)).toBe(false);
  });
  it('blocks prepared canonical IP when enhanced matching is disabled during processing', async () => {
    const f = await fixture();
    const repo = new ConversionDeliveryRepository();
    await prisma.conversionDestination.update({ where: { id: f.destination.id }, data: { configJson: { enhancedMatching: false } } });
    expect(await repo.hasAdvertisingConsent({ ...f.claim, match: { clientIp: '203.0.113.9' } })).toBe(false);
    expect(await repo.hasAdvertisingConsent({ ...f.claim, matchingIntent: true })).toBe(false);
  });
});

db('collector durability privacy races', () => {
  it('does not persist an advertising bundle when collection races withdrawal', async () => {
    const f = await fixture();
    const eventId = randomUUID();
    await Promise.all([
      new PixelRepository().insertEvents(f.store.id, [{
        eventId, eventName: 'PAGE_VIEW', eventAt: f.now, sessionId: f.event.sessionId,
        anonymousVisitorId: 'same-visitor', consentState: 'GRANTED', adSharingAllowed: true,
        browserMatchCiphertext: 'encrypted-late-bundle', browserMatchExpiresAt: new Date(Date.now() + 3600_000),
        retentionExpiresAt: new Date(Date.now() + 86400_000),
      }], new Date()),
      new PixelRepository().withdrawAdvertisingConsent(f.store.id, { anonymousVisitorId: 'same-visitor' },
        new Date(f.now.getTime() + 1000), new Date(Date.now() + 40 * 86400_000)),
    ]);
    expect(await prisma.storefrontEvent.findUnique({ where: { storeId_eventId: { storeId: f.store.id, eventId } } }))
      .toMatchObject({ adSharingAllowed: false, browserMatchCiphertext: null });
  });
});
