import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  for (const id of stores.splice(0)) {
    await prisma.order.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } });
  }
});

describeDatabase('Advertising consent for purchase sharing', () => {
  it.each(['session', 'visitor'] as const)(
    'requires explicit advertising permission and persists %s withdrawal with tenant isolation',
    async (scope) => {
      const unique = randomUUID();
      const now = new Date();
      const sessionId = randomUUID();
      const store = await prisma.store.create({
        data: {
          shopifyShopId: unique,
          myshopifyDomain: `${unique}.myshopify.com`,
          name: 'Consent test',
          currencyCode: 'USD',
          ianaTimezone: 'UTC',
        },
      });
      stores.push(store.id);
      const order = await prisma.order.create({
        data: {
          storeId: store.id,
          shopifyOrderId: unique,
          name: '#1',
          shopifyCreatedAt: now,
          currencyCode: 'USD',
          currentTotalAmount: '10',
        },
      });
      await prisma.storefrontSession.create({
        data: {
          storeId: store.id,
          browserSessionId: sessionId,
          anonymousVisitorId: unique,
          startedAt: now,
          endedAt: now,
          lastSourceReceivedAt: now,
          eventCount: 1,
          orderId: order.id,
          orderLinkStatus: 'LINKED',
          retentionExpiresAt: new Date(now.getTime() + 86400_000),
        },
      });
      const event = await prisma.storefrontEvent.create({
        data: {
          storeId: store.id,
          sessionId,
          anonymousVisitorId: unique,
          eventId: randomUUID(),
          eventName: 'PAGE_VIEW',
          eventAt: now,
          consentState: 'GRANTED',
          metaClickId: 'meta-click',
          googleClickId: 'google-click',
          tiktokClickId: 'tiktok-click',
          retentionExpiresAt: new Date(now.getTime() + 86400_000),
        },
      });
      const repo = new ConversionDeliveryRepository();
      const claim = {
        sourceOrderId: order.id,
        storeId: store.id,
        provider: 'META' as const,
        clickId: 'meta-click',
      };
      expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
      expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
      await prisma.storefrontEvent.update({
        where: { id: event.id },
        data: { adSharingAllowed: true },
      });
      expect(await repo.findPurchaseCandidates(10, order.id)).toMatchObject([
        { metaClickId: 'meta-click', googleClickId: 'google-click', tiktokClickId: 'tiktok-click' },
      ]);
      expect(await repo.hasAdvertisingConsent(claim)).toBe(true);
      expect(await repo.hasAdvertisingConsent({ ...claim, storeId: randomUUID() })).toBe(false);
      // A withdrawal is a privacy-only write: it must block every provider without a new
      // page/checkout event, and it must not affect the same opaque session in another tenant.
      const otherId = randomUUID();
      const other = await prisma.store.create({
        data: {
          shopifyShopId: otherId,
          myshopifyDomain: `${otherId}.myshopify.com`,
          name: 'Other consent tenant',
          currencyCode: 'USD',
          ianaTimezone: 'UTC',
        },
      });
      stores.push(other.id);
      const pixel = new PixelRepository();
      const cutoff = new Date(now.getTime() + 10 * 60_000);
      const retentionExpiresAt = new Date(now.getTime() + 90 * 86400_000);
      const withdrawal = scope === 'session' ? { sessionId } : { anonymousVisitorId: unique };
      await pixel.withdrawAdvertisingConsent(other.id, withdrawal, cutoff, retentionExpiresAt);
      expect(await repo.hasAdvertisingConsent(claim)).toBe(true);
      await pixel.withdrawAdvertisingConsent(store.id, withdrawal, cutoff, retentionExpiresAt);
      expect(await prisma.storefrontEvent.count({ where: { storeId: store.id } })).toBe(1);
      for (const [provider, clickId] of [
        ['META', 'meta-click'],
        ['TIKTOK', 'tiktok-click'],
        ['GOOGLE_ADS', 'google-click'],
      ] as const) {
        expect(await repo.hasAdvertisingConsent({ ...claim, provider, clickId })).toBe(false);
      }
      // A batch accepted later cannot restore previously withdrawn source permission.
      const late = {
        eventId: randomUUID(),
        eventName: 'PAGE_VIEW' as const,
        eventAt: now,
        receivedAt: now,
        sessionId,
        anonymousVisitorId: unique,
        consentState: 'GRANTED' as const,
        adSharingAllowed: true,
        metaClickId: 'meta-click',
        retentionExpiresAt,
      };
      await pixel.insertEvents(store.id, [late], now);
      expect(
        await prisma.storefrontEvent.findUnique({
          where: { storeId_eventId: { storeId: store.id, eventId: late.eventId } },
        }),
      ).toMatchObject({ adSharingAllowed: false });
      // Even a concurrent write that read the pre-withdrawal snapshot is blocked by the
      // delivery query's durable marker, rather than relying only on the stored boolean.
      await prisma.storefrontEvent.updateMany({
        where: { storeId: store.id },
        data: { adSharingAllowed: true },
      });
      expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
      // A later regrant may authorize new purchases; it cannot authorize this old purchase.
      await pixel.insertEvents(
        store.id,
        [{ ...late, eventId: randomUUID(), eventAt: new Date(cutoff.getTime() + 1000) }],
        now,
      );
      expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
      await prisma.storefrontEvent.create({
        data: {
          storeId: store.id,
          sessionId,
          eventId: randomUUID(),
          eventName: 'PAGE_VIEW',
          eventAt: new Date(now.getTime() + 1000),
          consentState: 'GRANTED',
          adSharingAllowed: false,
          retentionExpiresAt: new Date(now.getTime() + 86400_000),
        },
      });
      expect(await repo.findPurchaseCandidates(10, order.id)).toEqual([]);
      expect(await repo.hasAdvertisingConsent(claim)).toBe(false);
    },
  );
});
