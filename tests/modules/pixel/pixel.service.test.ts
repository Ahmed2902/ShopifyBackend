import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { pixelIngestBatchSchema } from '../../../src/modules/pixel/pixel.schema.js';
import { PixelService } from '../../../src/modules/pixel/pixel.service.js';
import type { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixedNow = new Date('2026-09-04T12:00:00.000Z');

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function buildService(input?: {
  installation?: Record<string, unknown> | null;
  inserted?: number;
}) {
  const installation =
    input?.installation === undefined
      ? null
      : input.installation;

  const repository = {
    findInstallationByStoreId: vi.fn().mockResolvedValue(installation),
    findInstallationForIngress: vi.fn().mockResolvedValue(installation),
    upsertInstallation: vi.fn().mockImplementation(async (value) => ({
      id: value.id,
      storeId: value.storeId,
      collectorTokenPrefix: value.collectorTokenPrefix,
      shopifyWebPixelId: value.shopifyWebPixelId,
      status: value.status,
      installedAt: value.installedAt,
      lastEventAt: null,
      lastError: value.lastError,
      updatedAt: fixedNow,
    })),
    insertEvents: vi.fn().mockResolvedValue(input?.inserted ?? 1),
    touchInstallation: vi.fn().mockResolvedValue({ id: installationId }),
    findExpiredEventIds: vi.fn().mockResolvedValue(['event-db-id']),
    deleteEventsByIds: vi.fn().mockResolvedValue(1),
  } as unknown as PixelRepository;

  const shopifyProvisioner = {
    upsert: vi.fn().mockResolvedValue({ id: 'gid://shopify/WebPixel/1' }),
  } as unknown as ShopifyPixelProvisioner;

  return {
    repository,
    shopifyProvisioner,
    service: new PixelService(repository, shopifyProvisioner, () => fixedNow),
  };
}

describe('PixelService', () => {
  it('rotates a collector credential without returning or persisting the raw token', async () => {
    const { repository, shopifyProvisioner, service } = buildService();

    const result = await service.installShopifyPixel(storeId);

    const provisionCall = vi.mocked(shopifyProvisioner.upsert).mock.calls[0]?.[0];
    const persistCall = vi.mocked(repository.upsertInstallation).mock.calls[0]?.[0];
    const rawToken = provisionCall?.settings.collectorToken;

    expect(rawToken).toBeTruthy();
    expect(rawToken).toHaveLength(43);
    expect(persistCall?.collectorTokenHash).toBe(tokenHash(rawToken!));
    expect(persistCall?.collectorTokenPrefix).toBe(rawToken!.slice(0, 8));
    expect(JSON.stringify(persistCall)).not.toContain(rawToken!);
    expect(result).not.toHaveProperty('collectorToken');
    expect(result).toMatchObject({
      status: 'ACTIVE',
      shopifyWebPixelId: 'gid://shopify/WebPixel/1',
      collectorUrl: 'http://localhost:3001/v1/pixel/events',
    });
  });

  it('suppresses denied events and stores only privacy-normalized allowlisted attribution', async () => {
    const collectorToken = 'A'.repeat(43);
    const { repository, service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash(collectorToken),
        status: 'ACTIVE',
      },
      inserted: 1,
    });

    const batch = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken,
      events: [
        {
          eventId: 'event_001',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:00.000Z',
          consentState: 'GRANTED',
          pageUrl:
            'https://shop.example/products/shirt?utm_source=meta&fbclid=click-1&email=private@example.com#details',
          landingPageUrl:
            'https://shop.example/?utm_campaign=launch&utm_medium=paid-social&secret=do-not-store',
        },
        {
          eventId: 'event_002',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:30.000Z',
          consentState: 'DENIED',
          pageUrl: 'https://shop.example/private?utm_source=should-not-persist',
        },
      ],
    });

    const result = await service.ingest(batch);

    expect(result).toEqual({
      received: 2,
      persisted: 1,
      duplicates: 0,
      suppressedForConsent: 1,
    });
    expect(repository.insertEvents).toHaveBeenCalledTimes(1);
    const [, events] = vi.mocked(repository.insertEvents).mock.calls[0]!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'event_001',
      pageUrl: 'https://shop.example/products/shirt',
      landingPageUrl: 'https://shop.example/',
      utmSource: 'meta',
      utmMedium: 'paid-social',
      utmCampaign: 'launch',
      metaClickId: 'click-1',
      retentionExpiresAt: new Date('2026-12-03T12:00:00.000Z'),
    });
    expect(JSON.stringify(events[0])).not.toContain('private@example.com');
    expect(JSON.stringify(events[0])).not.toContain('do-not-store');
    expect(repository.touchInstallation).toHaveBeenCalledWith(
      installationId,
      new Date('2026-09-04T11:59:00.000Z'),
    );
  });

  it('reports durable duplicate outcomes from createMany skipDuplicates', async () => {
    const collectorToken = 'B'.repeat(43);
    const { service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash(collectorToken),
        status: 'ACTIVE',
      },
      inserted: 0,
    });

    const batch = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken,
      events: [
        {
          eventId: 'event_dup',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:00.000Z',
          consentState: 'GRANTED',
        },
      ],
    });

    await expect(service.ingest(batch)).resolves.toMatchObject({
      received: 1,
      persisted: 0,
      duplicates: 1,
      suppressedForConsent: 0,
    });
  });

  it('rejects invalid collector credentials before any event write', async () => {
    const { repository, service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash('C'.repeat(43)),
        status: 'ACTIVE',
      },
    });

    const batch = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken: 'D'.repeat(43),
      events: [
        {
          eventId: 'event_bad',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:00.000Z',
          consentState: 'GRANTED',
        },
      ],
    });

    await expect(service.ingest(batch)).rejects.toMatchObject({
      statusCode: 401,
      code: 'PIXEL_UNAUTHORIZED',
    });
    expect(repository.insertEvents).not.toHaveBeenCalled();
  });

  it('deletes expired events in bounded batches', async () => {
    const { repository, service } = buildService();

    await expect(service.cleanupExpiredEvents(500_000)).resolves.toEqual({
      selected: 1,
      deleted: 1,
    });
    expect(repository.findExpiredEventIds).toHaveBeenCalledWith(fixedNow, 10_000);
    expect(repository.deleteEventsByIds).toHaveBeenCalledWith(['event-db-id']);
  });
});
