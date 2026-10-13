import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { checkoutProofHash } from '../../../src/modules/conversion-delivery/checkout-proof.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { ConversionDeliveryService } from '../../../src/modules/conversion-delivery/conversion-delivery.service.js';
import { purchaseRoutingPreview } from '../../../src/modules/conversion-delivery/routing-preview.js';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
const db = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const storeId of stores.splice(0)) {
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.shopifyConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});
async function fixture() {
  const unique = randomUUID(),
    now = new Date(),
    visitor = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: unique,
      myshopifyDomain: `${unique}.myshopify.com`,
      name: 'Routing',
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
      installedAt: new Date(now.getTime() - 35 * 86400_000),
    },
  });
  const proof = checkoutProofHash(store.id, unique);
  const order = await prisma.order.create({
    data: {
      storeId: store.id,
      shopifyOrderId: unique,
      name: '#100',
      shopifyCreatedAt: now,
      currencyCode: 'USD',
      currentTotalAmount: '20',
      checkoutTokenHash: proof,
    },
  });
  const source = await prisma.storefrontEvent.create({
    data: {
      storeId: store.id,
      eventId: randomUUID(),
      eventName: 'BEGIN_CHECKOUT',
      eventAt: now,
      checkoutTokenHash: proof,
      anonymousVisitorId: visitor,
      sessionId: 'checkout-session',
      consentState: 'GRANTED',
      adSharingAllowed: true,
      browserMatchCiphertext: encryptSecret(
        JSON.stringify({
          clientIp: '8.8.4.4',
          clientIpSource: 'COLLECTOR',
          userAgent: 'Observed browser',
        }),
      ),
      browserMatchExpiresAt: new Date(now.getTime() + 86400_000),
      retentionExpiresAt: new Date(now.getTime() + 86400_000),
    },
  });
  const destinations = await Promise.all(
    (['META', 'TIKTOK', 'GOOGLE_ADS'] as const).map((provider) =>
      prisma.conversionDestination.create({
        data: {
          storeId: store.id,
          provider,
          externalId: unique + provider,
          configJson: { enhancedMatching: false },
        },
      }),
    ),
  );
  const add = (data: Record<string, unknown>) =>
    prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: randomUUID(),
        eventName: 'PAGE_VIEW',
        eventAt: new Date(now.getTime() - 60_000),
        anonymousVisitorId: visitor,
        sessionId: randomUUID(),
        consentState: 'GRANTED',
        adSharingAllowed: true,
        retentionExpiresAt: new Date(now.getTime() + 86400_000),
        ...data,
      } as never,
    });
  return {
    store,
    order,
    source,
    connection,
    destinations,
    add,
    now,
    repo: new ConversionDeliveryRepository(),
  };
}
db('source-based routing against migrated PostgreSQL', () => {
  it.each(['META', 'TIKTOK', 'GOOGLE_ADS'] as const)(
    'queues a %s journey only to its channel despite all destinations being active',
    async (provider) => {
      const f = await fixture();
      await f.add({
        utmSource: provider === 'META' ? 'meta' : provider === 'TIKTOK' ? 'tiktok' : 'google',
        ...(provider === 'GOOGLE_ADS' ? { googleClickId: 'test-only-gclid-never-uploaded' } : {}),
        utmMedium: 'cpc',
      });
      const [candidate] = await f.repo.findPurchaseCandidates(1, f.order.id, false, f.store.id);
      expect(candidate!.routing?.eligibleProviders).toEqual([provider]);
      // Isolate this worker batch from other simultaneously executing database suites.
      vi.spyOn(f.repo, 'findPurchaseCandidates').mockResolvedValue([candidate!]);
      vi.spyOn(f.repo, 'activeDestinations').mockResolvedValue(f.destinations);
      const billing = { requireAdProviderReadOnly: vi.fn().mockResolvedValue({}) };
      const service = new ConversionDeliveryService(f.repo, () => f.now, billing as never);
      await service.enqueuePurchases();
      await service.enqueuePurchases();
      expect(
        await prisma.conversionDelivery.findMany({
          where: { storeId: f.store.id },
          select: { provider: true },
        }),
      ).toEqual([{ provider }]);
      const claim = {
        sourceOrderId: f.order.id,
        storeId: f.store.id,
        sourceEventId: f.source.id,
        sourceGenerationAt: f.connection.installedAt,
        provider: 'META' as const,
        destinationId: f.destinations[0]!.id,
        clickId: null,
      };
      if (provider === 'META') {
        expect(await f.repo.hasAdvertisingConsent(claim)).toBe(true);
        await prisma.storefrontEvent.updateMany({
          where: { storeId: f.store.id },
          data: { utmSource: null, utmMedium: null },
        });
        await expect(
          f.repo.hasAdvertisingConsent({ ...claim, reportConnectionFailure: true }),
        ).rejects.toHaveProperty('providerCode', 'SOURCE_ROUTE_BLOCKED');
      } else expect(await f.repo.hasAdvertisingConsent(claim)).toBe(false);
    },
  );
  it('keeps both eligible touches, last-touch credit and source eligibility distinct', async () => {
    const f = await fixture();
    await f.add({
      tiktokClickId: 'test-only-ttclid',
      eventAt: new Date(f.now.getTime() - 120_000),
    });
    await f.add({ utmSource: 'meta', utmMedium: 'paid_social', utmCampaign: 'Declared label' });
    const preview = await purchaseRoutingPreview(f.store.id, f.order.id);
    expect(preview.routing.eligibleProviders).toEqual(['TIKTOK', 'META']);
    expect(preview.routing.lastPaidTouch?.provider).toBe('META');
    expect(preview.channels.find((c) => c.provider === 'GOOGLE_ADS')?.sourceEligible).toBe(false);
    await expect(purchaseRoutingPreview(randomUUID(), f.order.id)).rejects.toHaveProperty(
      'code',
      'ORDER_NOT_FOUND',
    );
  });
  it('does not infer routes from browser IP, rejects ambiguous evidence and honors withdrawal', async () => {
    const f = await fixture();
    let [candidate] = await f.repo.findPurchaseCandidates(1, f.order.id, false, f.store.id);
    expect(candidate!.routing?.reason).toBe('NO_PAID_TOUCH');
    await f.add({ googleClickId: 'test-only-gclid', tiktokClickId: 'test-only-ttclid' });
    [candidate] = await f.repo.findPurchaseCandidates(1, f.order.id, false, f.store.id);
    expect(candidate!.routing?.reason).toBe('AMBIGUOUS_TOUCH');
    await new PixelRepository().withdrawAdvertisingConsent(
      f.store.id,
      { anonymousVisitorId: f.source.anonymousVisitorId! },
      f.now,
      new Date(f.now.getTime() + 86400_000),
    );
    expect(await f.repo.findPurchaseCandidates(1, f.order.id, false, f.store.id)).toEqual([]);
  });
  it('excludes expired, future, previous-generation, unrelated visitor and other-store touches', async () => {
    const f = await fixture(),
      other = await fixture();
    await f.add({
      tiktokClickId: 'test-expired',
      eventAt: new Date(f.now.getTime() - 31 * 86400_000),
    });
    await f.add({ googleClickId: 'test-future', eventAt: new Date(f.now.getTime() + 1000) });
    await f.add({ utmSource: 'meta', utmMedium: 'paid_social', anonymousVisitorId: randomUUID() });
    await other.add({ tiktokClickId: 'foreign', anonymousVisitorId: f.source.anonymousVisitorId });
    const [candidate] = await f.repo.findPurchaseCandidates(1, f.order.id, false, f.store.id);
    expect(candidate!.routing?.eligibleProviders).toEqual([]);
  });
});
