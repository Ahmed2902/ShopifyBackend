import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { billingService } from '../../../src/modules/billing/billing.service.js';
import {
  authorizeBrowserSignals,
  permittedBrowserPairs,
} from '../../../src/modules/conversion-delivery/browser-signals.js';
import { conversionSignalHealth } from '../../../src/modules/conversion-delivery/signal-diagnostics.js';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { decryptSecret } from '../../../src/modules/integrations/integration.utils.js';

const database = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const storeId of stores.splice(0)) {
    await prisma.shopifyConnection.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});
async function fixture(eventId = randomUUID()) {
  const id = randomUUID();
  const generation = new Date(Date.now() - 10_000);
  const token = 'a'.repeat(48);
  const store = await prisma.store.create({
    data: {
      shopifyShopId: id,
      myshopifyDomain: `${id}.myshopify.com`,
      name: 'Browser signals DB test',
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
      scopes: ['read_customer_events'],
      installedAt: generation,
    },
  });
  const installation = await prisma.pixelInstallation.create({
    data: {
      storeId: store.id,
      collectorTokenHash: createHash('sha256').update(token).digest('hex'),
      collectorTokenPrefix: token.slice(0, 12),
      status: 'ACTIVE',
    },
  });
  const destination = await prisma.conversionDestination.create({
    data: {
      storeId: store.id,
      provider: 'META',
      externalId: '123456789',
      configJson: { browserEvents: true, funnelEvents: true, overlapPolicy: 'STRIDE_EXCLUSIVE' },
    },
  });
  const event = await prisma.storefrontEvent.create({
    data: {
      storeId: store.id,
      eventId,
      eventName: 'PAGE_VIEW',
      eventAt: new Date(Date.now() - 1000),
      anonymousVisitorId: randomUUID(),
      sessionId: randomUUID(),
      consentState: 'GRANTED',
      adSharingAllowed: true,
      retentionExpiresAt: new Date(Date.now() + 86400_000),
    },
  });
  const input = { installationId: installation.id, collectorToken: token, eventIds: [eventId] };
  vi.spyOn(billingService, 'requireAdProviderReadOnly').mockResolvedValue(undefined as never);
  return { store, installation, destination, event, generation, input };
}
database('browser/server sharing against migrated PostgreSQL', () => {
  it('keeps IDs stable across retries, isolates stores, stores an actual SDK cookie encrypted and reports SDK invocation', async () => {
    const first = await fixture();
    const other = await fixture(first.event.eventId);
    const fbp = `fb.1.${Date.now() - 500}.123456`;
    const response = await authorizeBrowserSignals({ ...first.input, fbp });
    const replay = await authorizeBrowserSignals(first.input);
    expect(response.dispatches).toHaveLength(1);
    expect(replay.dispatches[0]!.eventId).toBe(response.dispatches[0]!.eventId);
    const foreign = await authorizeBrowserSignals(other.input);
    expect(foreign.dispatches[0]!.eventId).not.toBe(response.dispatches[0]!.eventId);
    expect(await prisma.conversionDelivery.count({ where: { storeId: first.store.id } })).toBe(1);
    const retained = await prisma.storefrontEvent.findUniqueOrThrow({
      where: { id: first.event.id },
    });
    expect(retained.browserMatchCiphertext).not.toContain(fbp);
    expect(JSON.parse(decryptSecret(retained.browserMatchCiphertext!)).fbp).toBe(fbp);
    await authorizeBrowserSignals({
      ...first.input,
      dispatchedDestinationIds: [first.destination.id],
    });
    expect((await authorizeBrowserSignals(first.input)).dispatches).toEqual([]);
    const health = await conversionSignalHealth(first.store.id);
    const meta = health.providers.find((p) => p.provider === 'META')!;
    expect(meta.funnel[0]).toMatchObject({
      collected: 1,
      consented: 1,
      queued: 1,
      acknowledged: 0,
      browserReported: 1,
    });
    expect(JSON.stringify(health)).not.toContain(fbp);
  });
  it('blocks withdrawn and late regranted stale events, wrong destinations and older installation generations', async () => {
    const f = await fixture();
    const other = await fixture();
    expect(
      (await permittedBrowserPairs(f.store.id, f.generation, [f.event.id], [other.destination.id]))
        .size,
    ).toBe(0);
    expect((await authorizeBrowserSignals(f.input)).dispatches).toHaveLength(1);
    await new PixelRepository().withdrawAdvertisingConsent(
      f.store.id,
      { anonymousVisitorId: f.event.anonymousVisitorId! },
      new Date(),
      new Date(Date.now() + 40 * 86400_000),
    );
    expect((await authorizeBrowserSignals(f.input)).dispatches).toEqual([]);
    // Even an accidentally restored source bit cannot override the privacy-only tombstone.
    await prisma.storefrontEvent.update({
      where: { id: f.event.id },
      data: { adSharingAllowed: true },
    });
    expect((await authorizeBrowserSignals(f.input)).dispatches).toEqual([]);
    await prisma.shopifyConnection.update({
      where: { storeId: other.store.id },
      data: { installedAt: new Date() },
    });
    expect((await authorizeBrowserSignals(other.input)).dispatches).toEqual([]);
    await prisma.pixelInstallation.update({
      where: { id: other.installation.id },
      data: { status: 'DISABLED' },
    });
    await expect(authorizeBrowserSignals(other.input)).rejects.toHaveProperty(
      'code',
      'PIXEL_UNAUTHORIZED',
    );
  });
  it('blocks settings revocation and refuses pre-withdrawal browser identifiers on a fresh granted event', async () => {
    const f = await fixture();
    const past = new Date(Date.now() - 2000);
    await prisma.storefrontConsentWithdrawal.create({
      data: {
        storeId: f.store.id,
        scopeKey: `visitor:${f.event.anonymousVisitorId}`,
        revokedBefore: past,
        retentionExpiresAt: new Date(Date.now() + 40 * 86400_000),
      },
    });
    const oldFbp = `fb.1.${Date.now() - 5000}.123456`;
    expect((await authorizeBrowserSignals({ ...f.input, fbp: oldFbp })).dispatches).toHaveLength(1);
    expect(
      (await prisma.storefrontEvent.findUniqueOrThrow({ where: { id: f.event.id } }))
        .browserMatchCiphertext,
    ).toBeNull();
    await prisma.conversionDestination.update({
      where: { id: f.destination.id },
      data: {
        configJson: { browserEvents: false, funnelEvents: true, overlapPolicy: 'STRIDE_EXCLUSIVE' },
      },
    });
    expect((await authorizeBrowserSignals(f.input)).dispatches).toEqual([]);
  });
});
