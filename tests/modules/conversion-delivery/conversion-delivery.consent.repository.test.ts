import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  for (const id of stores.splice(0)) {
    await prisma.order.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } });
  }
});

describeDatabase('Advertising consent for purchase sharing', () => {
  it('requires explicit advertising permission, rechecks withdrawal and isolates tenant permission', async () => {
    const unique = randomUUID(); const now = new Date(); const sessionId = randomUUID();
    const store = await prisma.store.create({ data: { shopifyShopId: unique, myshopifyDomain: `${unique}.myshopify.com`,
      name: 'Consent test', currencyCode: 'USD', ianaTimezone: 'UTC' } });
    stores.push(store.id);
    const order = await prisma.order.create({ data: { storeId: store.id, shopifyOrderId: unique, name: '#1',
      shopifyCreatedAt: now, currencyCode: 'USD', currentTotalAmount: '10' } });
    await prisma.storefrontSession.create({ data: { storeId: store.id, browserSessionId: sessionId,
      startedAt: now, endedAt: now, lastSourceReceivedAt: now, eventCount: 1, orderId: order.id,
      orderLinkStatus: 'LINKED', retentionExpiresAt: new Date(now.getTime() + 86400_000) } });
    const event = await prisma.storefrontEvent.create({ data: { storeId: store.id, sessionId, eventId: randomUUID(),
      eventName: 'PAGE_VIEW', eventAt: now, consentState: 'GRANTED', metaClickId: 'meta-click', googleClickId: 'google-click',
      tiktokClickId: 'tiktok-click', retentionExpiresAt: new Date(now.getTime() + 86400_000) } });
    const repo = new ConversionDeliveryRepository();
    const claim = { sourceOrderId: order.id, storeId: store.id, provider: 'META' as const, clickId: 'meta-click' };
    expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
    expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
    await prisma.storefrontEvent.update({ where: { id: event.id }, data: { adSharingAllowed: true } });
    expect(await repo.findPurchaseCandidates(10, order.id)).toMatchObject([{ metaClickId: 'meta-click', googleClickId: 'google-click', tiktokClickId: 'tiktok-click' }]);
    expect(await repo.hasAdvertisingConsent(claim)).toBe(true);
    expect(await repo.hasAdvertisingConsent({ ...claim, storeId: randomUUID() })).toBe(false);
    await prisma.storefrontEvent.create({ data: { storeId: store.id, sessionId, eventId: randomUUID(), eventName: 'PAGE_VIEW',
      eventAt: new Date(now.getTime() + 1000), consentState: 'GRANTED', adSharingAllowed: false,
      retentionExpiresAt: new Date(now.getTime() + 86400_000) } });
    expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
    expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
  });
});
