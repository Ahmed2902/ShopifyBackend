import { describe, expect, it, vi } from 'vitest';
import type { PixelHealthRepository } from '../../../src/modules/pixel/pixel-health.repository.js';
import { PixelHealthService } from '../../../src/modules/pixel/pixel-health.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-08T00:00:00.000Z');

function row() {
  return {
    installationStatus: 'ACTIVE',
    installationLastEventAt: new Date('2026-09-07T23:58:00.000Z'),
    installationLastError: null,
    acceptedEvents24h: 42,
    lastAcceptedEventAt: new Date('2026-09-07T23:58:00.000Z'),
    pendingRepairs: 3,
    oldestRepairAt: new Date('2026-09-07T23:55:00.000Z'),
    pendingOrderLinks: 1,
    oldestPendingOrderAt: new Date('2026-09-07T23:50:00.000Z'),
    behaviorDirtySessions: 2,
    behaviorOldestDirtyAt: new Date('2026-09-07T23:45:00.000Z'),
    behaviorLastRolledUpAt: new Date('2026-09-07T23:59:00.000Z'),
    behaviorLastError: null,
    attributionDirtySessions: 4,
    attributionOldestDirtyAt: new Date('2026-09-07T23:40:00.000Z'),
    attributionLastRolledUpAt: new Date('2026-09-07T23:57:00.000Z'),
    attributionLastError: 'last retry failed',
    expiredEventsPendingCleanup: 5,
    oldestExpiredEventAt: new Date('2026-09-07T23:30:00.000Z'),
    expiredSessionsPendingCleanup: 2,
    oldestExpiredSessionAt: new Date('2026-09-07T23:20:00.000Z'),
  };
}

describe('PixelHealthService', () => {
  it('exposes bounded queue, rollup and retention lag without inventing health thresholds', async () => {
    const repository = {
      read: vi.fn().mockResolvedValue(row()),
    } as unknown as PixelHealthRepository;
    const service = new PixelHealthService(repository, () => now);

    const result = await service.read(storeId);

    expect(repository.read).toHaveBeenCalledWith(storeId, now);
    expect(result).toMatchObject({
      checkedAt: now,
      installation: { status: 'ACTIVE', lastError: null },
      collector: {
        acceptedEvents24h: 42,
        lastAcceptedEventAgeMs: 120_000,
        rejectedBatchesSource: 'APPLICATION_LOGS',
      },
      journeyRepair: { pending: 3, oldestAgeMs: 300_000 },
      pendingOrderLinks: { pending: 1, oldestAgeMs: 600_000 },
      behaviorRollup: {
        pendingSessions: 2,
        oldestDirtyAgeMs: 900_000,
        lastRolledUpAgeMs: 60_000,
        lastError: null,
      },
      attributionRollup: {
        pendingSessions: 4,
        oldestDirtyAgeMs: 1_200_000,
        lastRolledUpAgeMs: 180_000,
        lastError: 'last retry failed',
      },
      retention: {
        expiredEventsPendingCleanup: 5,
        oldestExpiredEventAgeMs: 1_800_000,
        expiredSessionsPendingCleanup: 2,
        oldestExpiredSessionAgeMs: 2_400_000,
      },
    });
  });

  it('reports an existing store without a Pixel installation as NOT_INSTALLED', async () => {
    const repository = {
      read: vi.fn().mockResolvedValue({
        ...row(),
        installationStatus: null,
        installationLastEventAt: null,
        installationLastError: null,
      }),
    } as unknown as PixelHealthRepository;
    const service = new PixelHealthService(repository, () => now);

    const result = await service.read(storeId);
    expect(result.installation.status).toBe('NOT_INSTALLED');
  });

  it('keeps missing stores distinct from an uninstalled Pixel', async () => {
    const repository = {
      read: vi.fn().mockResolvedValue(null),
    } as unknown as PixelHealthRepository;
    const service = new PixelHealthService(repository, () => now);

    await expect(service.read(storeId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'STORE_NOT_FOUND',
    });
  });
});
