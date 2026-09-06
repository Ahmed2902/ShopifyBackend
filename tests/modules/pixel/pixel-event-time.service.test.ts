import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PixelJourneyService } from '../../../src/modules/pixel/journey/pixel-journey.service.js';
import type { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { pixelIngestBatchSchema } from '../../../src/modules/pixel/pixel.schema.js';
import { PixelService } from '../../../src/modules/pixel/pixel.service.js';
import type { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const collectorToken = 'T'.repeat(43);
const fixedNow = new Date('2026-09-05T12:00:00.000Z');

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function buildService() {
  const repository = {
    findInstallationForIngress: vi.fn().mockResolvedValue({
      id: installationId,
      storeId,
      collectorTokenHash: tokenHash(collectorToken),
      pendingCollectorTokenHash: null,
      status: 'ACTIVE',
    }),
    insertEvents: vi.fn().mockResolvedValue(1),
    touchInstallation: vi.fn().mockResolvedValue({ id: installationId }),
  } as unknown as PixelRepository;
  const journeyService = {
    materializeSessions: vi.fn().mockResolvedValue({ requested: 0, materialized: 0, failed: 0 }),
  } as unknown as PixelJourneyService;
  const service = new PixelService(
    repository,
    {} as ShopifyPixelProvisioner,
    () => fixedNow,
    journeyService,
  );
  return { repository, service };
}

function batch(eventAt: string) {
  return pixelIngestBatchSchema.parse({
    installationId,
    collectorToken,
    events: [
      {
        eventId: 'event_time_guard',
        eventName: 'PAGE_VIEW',
        eventAt,
        consentState: 'GRANTED',
      },
    ],
  });
}

describe('Pixel event-time guard', () => {
  it('rejects a far-future browser timestamp before persistence or freshness mutation', async () => {
    const { repository, service } = buildService();

    await expect(service.ingest(batch('9999-01-01T00:00:00.000Z'))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PIXEL_EVENT_TIME_INVALID',
    });
    expect(repository.insertEvents).not.toHaveBeenCalled();
    expect(repository.touchInstallation).not.toHaveBeenCalled();
  });

  it('rejects events older than the bounded client retry window', async () => {
    const { repository, service } = buildService();

    await expect(service.ingest(batch('2026-08-01T00:00:00.000Z'))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PIXEL_EVENT_TIME_INVALID',
    });
    expect(repository.insertEvents).not.toHaveBeenCalled();
  });
});
