import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PixelJourneyService } from '../../../src/modules/pixel/journey/pixel-journey.service.js';
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
  const installation = input?.installation === undefined ? null : input.installation;

  const repository = {
    findInstallationByStoreId: vi.fn().mockResolvedValue(installation),
    findInstallationForIngress: vi.fn().mockResolvedValue(installation),
    stageInstallation: vi.fn().mockImplementation(async (value) => ({
      id: value.id,
      storeId: value.storeId,
      status: value.status,
      shopifyWebPixelId: installation?.shopifyWebPixelId ?? null,
    })),
    finalizeInstallation: vi.fn().mockImplementation(async (value) => ({
      id: value.id,
      storeId,
      collectorTokenPrefix: 'NEWTOKEN',
      shopifyWebPixelId: value.shopifyWebPixelId,
      status: 'ACTIVE',
      installedAt: value.installedAt,
      lastEventAt: null,
      lastError: null,
      updatedAt: fixedNow,
    })),
    rollbackStagedInstallation: vi.fn().mockResolvedValue({
      id: installationId,
      status: installation?.status ?? 'ERROR',
    }),
    recordInstallationError: vi.fn().mockResolvedValue({ id: installationId, status: 'ACTIVE' }),
    insertEvents: vi.fn().mockResolvedValue(input?.inserted ?? 1),
    markSessionRepairs: vi.fn().mockResolvedValue(undefined),
    touchInstallation: vi.fn().mockResolvedValue({ id: installationId }),
    findExpiredEventIds: vi.fn().mockResolvedValue(['event-db-id']),
    deleteEventsByIds: vi.fn().mockResolvedValue(1),
  } as unknown as PixelRepository;

  const shopifyProvisioner = {
    upsert: vi.fn().mockResolvedValue({ id: 'gid://shopify/WebPixel/1' }),
  } as unknown as ShopifyPixelProvisioner;

  const journeyService = {
    materializeSessions: vi.fn().mockResolvedValue({ requested: 1, materialized: 1, failed: 0 }),
  } as unknown as PixelJourneyService;

  return {
    repository,
    shopifyProvisioner,
    journeyService,
    service: new PixelService(repository, shopifyProvisioner, () => fixedNow, journeyService),
  };
}

describe('PixelService', () => {
  it('stages and then promotes a collector credential without returning the raw token', async () => {
    const { repository, shopifyProvisioner, service } = buildService();

    const result = await service.installShopifyPixel(storeId);

    const provisionCall = vi.mocked(shopifyProvisioner.upsert).mock.calls[0]?.[0];
    const stageCall = vi.mocked(repository.stageInstallation).mock.calls[0]?.[0];
    const rawToken = provisionCall?.settings.collectorToken;

    expect(rawToken).toBeTruthy();
    expect(rawToken).toHaveLength(43);
    expect(stageCall?.collectorTokenHash).toBe(tokenHash(rawToken!));
    expect(stageCall?.collectorTokenPrefix).toBe(rawToken!.slice(0, 8));
    expect(stageCall?.status).toBe('PROVISIONING');
    expect(JSON.stringify(stageCall)).not.toContain(rawToken!);
    expect(repository.finalizeInstallation).toHaveBeenCalledWith({
      id: stageCall?.id,
      shopifyWebPixelId: 'gid://shopify/WebPixel/1',
      installedAt: fixedNow,
    });
    expect(result).not.toHaveProperty('collectorToken');
    expect(result).toMatchObject({
      status: 'ACTIVE',
      shopifyWebPixelId: 'gid://shopify/WebPixel/1',
      collectorUrl: 'http://localhost:3001/v1/pixel/events',
      requiredShopifyScopes: ['write_pixels', 'read_pixels', 'read_customer_events'],
    });
  });

  it('keeps a working installation ACTIVE while staging a rotation', async () => {
    const existing = {
      id: installationId,
      storeId,
      collectorTokenPrefix: 'OLDTOKEN',
      shopifyWebPixelId: 'gid://shopify/WebPixel/42',
      status: 'ACTIVE',
      installedAt: new Date('2026-09-01T12:00:00.000Z'),
      lastEventAt: null,
      lastError: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      updatedAt: fixedNow,
    };
    const { repository, service } = buildService({ installation: existing });

    await service.installShopifyPixel(storeId);

    expect(repository.stageInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ id: installationId, storeId, status: 'ACTIVE' }),
    );
  });

  it('moves a failed installation into PROVISIONING before retrying Shopify', async () => {
    const existing = {
      id: installationId,
      storeId,
      collectorTokenPrefix: 'FAILED',
      shopifyWebPixelId: null,
      status: 'ERROR',
      installedAt: null,
      lastEventAt: null,
      lastError: 'previous failure',
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      updatedAt: fixedNow,
    };
    const { repository, service } = buildService({ installation: existing });
    vi.mocked(repository.finalizeInstallation).mockRejectedValue(new Error('database unavailable'));

    await expect(service.installShopifyPixel(storeId)).rejects.toThrow('database unavailable');

    expect(repository.stageInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ id: installationId, storeId, status: 'PROVISIONING' }),
    );
    expect(repository.rollbackStagedInstallation).not.toHaveBeenCalled();
    expect(repository.recordInstallationError).toHaveBeenCalledWith(
      installationId,
      'database unavailable',
    );
  });

  it('rolls back only the staged credential when Shopify reprovision fails', async () => {
    const existing = {
      id: installationId,
      storeId,
      collectorTokenPrefix: 'OLDTOKEN',
      shopifyWebPixelId: 'gid://shopify/WebPixel/42',
      status: 'ACTIVE',
      installedAt: new Date('2026-09-01T12:00:00.000Z'),
      lastEventAt: new Date('2026-09-04T11:00:00.000Z'),
      lastError: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      updatedAt: new Date('2026-09-04T11:00:00.000Z'),
    };
    const { repository, shopifyProvisioner, service } = buildService({ installation: existing });
    vi.mocked(shopifyProvisioner.upsert).mockRejectedValue(new Error('provider failed'));

    await expect(service.installShopifyPixel(storeId)).rejects.toThrow('provider failed');

    expect(repository.stageInstallation).toHaveBeenCalledTimes(1);
    expect(repository.rollbackStagedInstallation).toHaveBeenCalledWith(
      installationId,
      true,
      'provider failed',
    );
    expect(repository.finalizeInstallation).not.toHaveBeenCalled();
  });

  it('keeps the staged credential recoverable when Shopify succeeds but local finalization fails', async () => {
    const existing = {
      id: installationId,
      storeId,
      collectorTokenPrefix: 'OLDTOKEN',
      shopifyWebPixelId: 'gid://shopify/WebPixel/42',
      status: 'ACTIVE',
      installedAt: new Date('2026-09-01T12:00:00.000Z'),
      lastEventAt: null,
      lastError: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      updatedAt: fixedNow,
    };
    const { repository, service } = buildService({ installation: existing });
    vi.mocked(repository.finalizeInstallation).mockRejectedValue(new Error('database unavailable'));

    await expect(service.installShopifyPixel(storeId)).rejects.toThrow('database unavailable');

    expect(repository.rollbackStagedInstallation).not.toHaveBeenCalled();
    expect(repository.recordInstallationError).toHaveBeenCalledWith(
      installationId,
      'database unavailable',
    );
  });

  it('accepts a staged collector token during a provisioning transition', async () => {
    const collectorToken = 'P'.repeat(43);
    const { repository, service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash('O'.repeat(43)),
        pendingCollectorTokenHash: tokenHash(collectorToken),
        status: 'PROVISIONING',
      },
      inserted: 1,
    });

    const batch = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken,
      events: [
        {
          eventId: 'event_pending_token',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:00.000Z',
          consentState: 'GRANTED',
        },
      ],
    });

    await expect(service.ingest(batch)).resolves.toMatchObject({ persisted: 1 });
    expect(repository.insertEvents).toHaveBeenCalledTimes(1);
  });

  it('suppresses denied events and stores only privacy-normalized allowlisted attribution', async () => {
    const collectorToken = 'A'.repeat(43);
    const { repository, service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash(collectorToken),
        pendingCollectorTokenHash: null,
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
            'https://shop.example/products/shirt?utm_source=meta&fbclid=click-1&stride_meta_campaign_id=1001&stride_meta_adset_id=2002&stride_meta_ad_id=3003&email=private@example.com#details',
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
      metaCampaignExternalId: '1001',
      metaAdSetExternalId: '2002',
      metaAdExternalId: '3003',
      retentionExpiresAt: new Date('2026-12-03T12:00:00.000Z'),
    });
    expect(JSON.stringify(events[0])).not.toContain('private@example.com');
    expect(JSON.stringify(events[0])).not.toContain('do-not-store');
    expect(repository.touchInstallation).toHaveBeenCalledWith(
      installationId,
      new Date('2026-09-04T11:59:00.000Z'),
    );
  });

  it('marks session repair state before attempting immediate materialization', async () => {
    const collectorToken = 'S'.repeat(43);
    const { repository, journeyService, service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash(collectorToken),
        pendingCollectorTokenHash: null,
        status: 'ACTIVE',
      },
      inserted: 1,
    });

    const batch = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken,
      events: [
        {
          eventId: 'event_session',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:00.000Z',
          consentState: 'GRANTED',
          sessionId: 'session-1',
        },
      ],
    });

    await service.ingest(batch);

    expect(repository.markSessionRepairs).toHaveBeenCalledWith(storeId, ['session-1'], fixedNow);
    expect(vi.mocked(repository.markSessionRepairs).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(journeyService.materializeSessions).mock.invocationCallOrder[0]!,
    );
  });

  it('ignores unresolved or non-numeric Meta IDs extracted from URLs', async () => {
    const collectorToken = 'E'.repeat(43);
    const { repository, service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash(collectorToken),
        pendingCollectorTokenHash: null,
        status: 'ACTIVE',
      },
      inserted: 1,
    });

    const batch = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken,
      events: [
        {
          eventId: 'event_unresolved',
          eventName: 'PAGE_VIEW',
          eventAt: '2026-09-04T11:59:00.000Z',
          consentState: 'GRANTED',
          pageUrl:
            'https://shop.example/?stride_meta_campaign_id=%7B%7Bcampaign.id%7D%7D&stride_meta_ad_id=not-an-id',
        },
      ],
    });

    await service.ingest(batch);
    const [, events] = vi.mocked(repository.insertEvents).mock.calls[0]!;
    expect(events[0]).toMatchObject({
      metaCampaignExternalId: null,
      metaAdSetExternalId: null,
      metaAdExternalId: null,
    });
  });

  it('reports durable duplicate outcomes from createMany skipDuplicates', async () => {
    const collectorToken = 'B'.repeat(43);
    const { service } = buildService({
      installation: {
        id: installationId,
        storeId,
        collectorTokenHash: tokenHash(collectorToken),
        pendingCollectorTokenHash: null,
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
        pendingCollectorTokenHash: null,
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

  it('deletes only expired events selected by the repair-aware repository gate', async () => {
    const { repository, service } = buildService();

    await expect(service.cleanupExpiredEvents(500_000)).resolves.toEqual({
      selected: 1,
      deleted: 1,
    });
    expect(repository.findExpiredEventIds).toHaveBeenCalledWith(fixedNow, 10_000);
    expect(repository.deleteEventsByIds).toHaveBeenCalledWith(['event-db-id']);
  });
});
