import { describe, expect, it } from 'vitest';
import { UnifiedAdvertisingService } from '../../../src/modules/advertising/unified-advertising.service.js';

type QualityReader = {
  dataQuality(input: {
    states: Array<{
      provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS';
      status: string | null;
      selectedExternalIds: string[];
      lastSyncedAt: Date | null;
      lastSyncStatus: string | null;
    }>;
    allSelectedAccounts: never[];
    scopedAccounts: never[];
    rows: never[];
    requestedProvider: string;
    requestedCurrency?: string;
    now: Date;
  }): Array<{ code: string; status: string; provider?: string }>;
};

function service() {
  return new UnifiedAdvertisingService({} as never, {} as never, {} as never, {} as never) as unknown as QualityReader;
}

describe('unified advertising sync data quality', () => {
  it('surfaces Meta partial sync as a warning', () => {
    const value = service().dataQuality({
      states: [
        {
          provider: 'META',
          status: 'ACTIVE',
          selectedExternalIds: [],
          lastSyncedAt: new Date('2026-09-23T10:00:00.000Z'),
          lastSyncStatus: 'PARTIAL',
        },
      ],
      allSelectedAccounts: [],
      scopedAccounts: [],
      rows: [],
      requestedProvider: 'META',
      now: new Date('2026-09-23T11:00:00.000Z'),
    });
    expect(value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PARTIAL_SYNC', status: 'WARNING', provider: 'META' }),
      ]),
    );
  });

  it('surfaces TikTok failed sync as a blocker', () => {
    const value = service().dataQuality({
      states: [
        {
          provider: 'TIKTOK',
          status: 'ACTIVE',
          selectedExternalIds: [],
          lastSyncedAt: new Date('2026-09-23T10:00:00.000Z'),
          lastSyncStatus: 'FAILED',
        },
      ],
      allSelectedAccounts: [],
      scopedAccounts: [],
      rows: [],
      requestedProvider: 'TIKTOK',
      now: new Date('2026-09-23T11:00:00.000Z'),
    });
    expect(value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FAILED_SYNC', status: 'BLOCKED', provider: 'TIKTOK' }),
      ]),
    );
  });
});
