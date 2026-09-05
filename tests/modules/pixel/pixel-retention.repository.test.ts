import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
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
});