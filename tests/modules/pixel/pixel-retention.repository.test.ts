import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { PixelJourneyRepository } from '../../../src/modules/pixel/journey/pixel-journey.repository.js';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Pixel retention test store',
      myshopifyDomain: `pixel-retention-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  createdStoreIds.push(store.id);
  return store;
}

afterEach(async () => {
  while (createdStoreIds.length > 0) {
    await prisma.store.deleteMany({ where: { id: createdStoreIds.pop()! } });
  }
});

describeDatabase('Pixel retention repository', () => {
  it('deletes expired source evidence even with a repair marker and rotates repair for surviving events', async () => {
    const store = await createStore();
    const repository = new PixelRepository();
    const sessionId = `session-${randomUUID()}`;
    const now = new Date('2026-09-05T12:00:00.000Z');
    const oldReceivedAt = new Date('2026-06-01T12:00:00.000Z');
    const newReceivedAt = new Date('2026-09-05T11:00:00.000Z');

    const [expired, surviving] = await Promise.all([
      prisma.storefrontEvent.create({
        data: {
          storeId: store.id,
          eventId: `expired-${randomUUID()}`,
          eventName: 'PAGE_VIEW',
          eventAt: oldReceivedAt,
          receivedAt: oldReceivedAt,
          sessionId,
          consentState: 'GRANTED',
          retentionExpiresAt: new Date('2026-09-05T11:59:00.000Z'),
        },
      }),
      prisma.storefrontEvent.create({
        data: {
          storeId: store.id,
          eventId: `surviving-${randomUUID()}`,
          eventName: 'PRODUCT_VIEW',
          eventAt: newReceivedAt,
          receivedAt: newReceivedAt,
          sessionId,
          consentState: 'GRANTED',
          retentionExpiresAt: new Date('2026-12-04T11:00:00.000Z'),
        },
      }),
    ]);

    const originalRepair = await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId: sessionId,
        sourceReceivedAt: oldReceivedAt,
      },
    });

    const expiredIds = await repository.findExpiredEventIds(now, 10_000);
    expect(expiredIds).toContain(expired.id);

    await expect(repository.deleteEventsByIds([expired.id])).resolves.toBe(1);

    await expect(prisma.storefrontEvent.findUnique({ where: { id: expired.id } })).resolves.toBeNull();
    await expect(prisma.storefrontEvent.findUnique({ where: { id: surviving.id } })).resolves.toMatchObject({
      id: surviving.id,
    });

    const repair = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } },
    });
    expect(repair.id).not.toBe(originalRepair.id);
    expect(repair.sourceReceivedAt).toEqual(newReceivedAt);
  });

  it('invalidates the retained read model when the final raw source expires', async () => {
    const store = await createStore();
    const repository = new PixelRepository();
    const sessionId = `session-final-${randomUUID()}`;
    const visitorId = `visitor-${randomUUID()}`;
    const receivedAt = new Date('2026-06-01T12:00:00.000Z');
    const rolledAt = new Date('2026-06-01T13:00:00.000Z');

    const expired = await prisma.storefrontEvent.create({
      data: {
        storeId: store.id,
        eventId: `expired-final-${randomUUID()}`,
        eventName: 'PAGE_VIEW',
        eventAt: receivedAt,
        receivedAt,
        sessionId,
        anonymousVisitorId: visitorId,
        consentState: 'GRANTED',
        pageUrl: 'https://example.test/products/old',
        retentionExpiresAt: new Date('2026-09-05T11:59:00.000Z'),
      },
    });
    const session = await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId: sessionId,
        anonymousVisitorId: visitorId,
        startedAt: receivedAt,
        endedAt: receivedAt,
        lastSourceReceivedAt: receivedAt,
        eventCount: 1,
        pageViewCount: 1,
        landingPageUrl: 'https://example.test/products/old',
        rollupDirtyAt: receivedAt,
        behaviorRolledUpAt: rolledAt,
        behaviorRolledStartedAt: receivedAt,
        attributionRolledUpAt: rolledAt,
        attributionRolledStartedAt: receivedAt,
        retentionExpiresAt: new Date('2026-09-05T11:59:00.000Z'),
      },
    });
    await prisma.storefrontSessionTouch.create({
      data: {
        sessionId: session.id,
        ordinal: 1,
        eventAt: receivedAt,
        source: 'DIRECT',
        landingPageUrl: 'https://example.test/products/old',
        metaResolutionStatus: 'NONE',
      },
    });
    const originalRepair = await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId: sessionId,
        sourceReceivedAt: receivedAt,
      },
    });

    await expect(repository.deleteEventsByIds([expired.id])).resolves.toBe(1);
    await expect(
      prisma.storefrontEvent.count({ where: { storeId: store.id, sessionId } }),
    ).resolves.toBe(0);

    const invalidated = await prisma.storefrontSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(invalidated.anonymousVisitorId).toBe(visitorId);
    expect(invalidated.startedAt).toEqual(receivedAt);
    expect(invalidated.eventCount).toBe(0);
    expect(invalidated.pageViewCount).toBe(0);
    expect(invalidated.checkoutCompletedAt).toBeNull();
    expect(invalidated.orderId).toBeNull();
    expect(invalidated.orderLinkStatus).toBe('NONE');
    expect(invalidated.landingPageUrl).toBeNull();
    expect(invalidated.rollupDirtyAt.getTime()).toBeGreaterThan(rolledAt.getTime());
    await expect(
      prisma.storefrontSessionTouch.count({ where: { sessionId: session.id } }),
    ).resolves.toBe(0);

    const repair = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId: sessionId } },
    });
    expect(repair.id).not.toBe(originalRepair.id);
    expect(repair.sourceReceivedAt).toEqual(receivedAt);
  });

  it('does not delete an expired rolled session while any repair generation is pending', async () => {
    const store = await createStore();
    const browserSessionId = `session-pending-repair-${randomUUID()}`;
    const startedAt = new Date('2026-06-01T10:00:00.000Z');
    const endedAt = new Date('2026-06-01T10:10:00.000Z');
    const rolledAt = new Date('2026-06-01T11:00:00.000Z');
    const session = await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId,
        startedAt,
        endedAt,
        lastSourceReceivedAt: endedAt,
        eventCount: 1,
        rollupDirtyAt: endedAt,
        behaviorRolledUpAt: rolledAt,
        behaviorRolledStartedAt: startedAt,
        attributionRolledUpAt: rolledAt,
        attributionRolledStartedAt: startedAt,
        retentionExpiresAt: new Date('2026-09-05T11:00:00.000Z'),
      },
    });
    await prisma.storefrontSessionRepair.create({
      data: {
        storeId: store.id,
        browserSessionId,
        sourceReceivedAt: endedAt,
      },
    });

    const result = await new PixelJourneyRepository().deleteExpiredSessions(
      new Date('2026-09-05T12:00:00.000Z'),
      100,
    );

    expect(result.deleted).toBe(0);
    await expect(prisma.storefrontSession.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      id: session.id,
    });
  });
});
