import { AppError } from '../../errors/app-error.js';
import { PixelHealthRepository } from './pixel-health.repository.js';

function ageMs(now: Date, value: Date | null): number | null {
  return value ? Math.max(0, now.getTime() - value.getTime()) : null;
}

export class PixelHealthService {
  constructor(
    private readonly repository: PixelHealthRepository = new PixelHealthRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(storeId: string) {
    const checkedAt = this.now();
    const row = await this.repository.read(storeId, checkedAt);
    if (!row) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    return {
      checkedAt,
      installation: {
        status: row.installationStatus ?? ('NOT_INSTALLED' as const),
        lastEventAt: row.installationLastEventAt,
        lastError: row.installationLastError,
      },
      collector: {
        acceptedEvents24h: row.acceptedEvents24h,
        lastAcceptedEventAt: row.lastAcceptedEventAt,
        lastAcceptedEventAgeMs: ageMs(checkedAt, row.lastAcceptedEventAt),
        rejectedBatchesSource: 'APPLICATION_LOGS' as const,
      },
      journeyRepair: {
        pending: row.pendingRepairs,
        oldestQueuedAt: row.oldestRepairAt,
        oldestAgeMs: ageMs(checkedAt, row.oldestRepairAt),
      },
      pendingOrderLinks: {
        pending: row.pendingOrderLinks,
        oldestPendingAt: row.oldestPendingOrderAt,
        oldestAgeMs: ageMs(checkedAt, row.oldestPendingOrderAt),
      },
      behaviorRollup: {
        pendingSessions: row.behaviorDirtySessions,
        oldestDirtyAt: row.behaviorOldestDirtyAt,
        oldestDirtyAgeMs: ageMs(checkedAt, row.behaviorOldestDirtyAt),
        lastRolledUpAt: row.behaviorLastRolledUpAt,
        lastRolledUpAgeMs: ageMs(checkedAt, row.behaviorLastRolledUpAt),
        lastError: row.behaviorLastError,
      },
      attributionRollup: {
        pendingSessions: row.attributionDirtySessions,
        oldestDirtyAt: row.attributionOldestDirtyAt,
        oldestDirtyAgeMs: ageMs(checkedAt, row.attributionOldestDirtyAt),
        lastRolledUpAt: row.attributionLastRolledUpAt,
        lastRolledUpAgeMs: ageMs(checkedAt, row.attributionLastRolledUpAt),
        lastError: row.attributionLastError,
      },
      retention: {
        expiredEventsPendingCleanup: row.expiredEventsPendingCleanup,
        oldestExpiredEventAt: row.oldestExpiredEventAt,
        oldestExpiredEventAgeMs: ageMs(checkedAt, row.oldestExpiredEventAt),
        expiredSessionsPendingCleanup: row.expiredSessionsPendingCleanup,
        oldestExpiredSessionAt: row.oldestExpiredSessionAt,
        oldestExpiredSessionAgeMs: ageMs(checkedAt, row.oldestExpiredSessionAt),
      },
    };
  }
}

export const pixelHealthService = new PixelHealthService();
