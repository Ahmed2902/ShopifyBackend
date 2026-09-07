import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceSnapshotReadService } from '../../../src/modules/intelligence/intelligence-snapshot.read.service.js';
import type { AnalyticsWorkspace } from '../../../src/modules/analytics/analytics.workspace.js';
import { ReportWorkspace } from '../../../src/modules/analytics/report.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-07T12:00:00.000Z');

function analytics(overrides: Partial<AnalyticsWorkspace> = {}) {
  return {
    overview: vi.fn().mockResolvedValue({ marker: 'overview' }),
    ...overrides,
  } as unknown as AnalyticsWorkspace;
}

function intelligence(overrides: Partial<IntelligenceSnapshotReadService> = {}) {
  return {
    read: vi.fn().mockResolvedValue({ marker: 'intelligence' }),
    invalidate: vi.fn(),
    ...overrides,
  } as unknown as IntelligenceSnapshotReadService;
}

describe('ReportWorkspace', () => {
  it('returns overview and intelligence through one composition', async () => {
    const reads = intelligence();
    const workspace = new ReportWorkspace(analytics(), reads);

    const result = await workspace.read(storeId, { days: 30 }, now, { fresh: true });

    expect(result).toEqual({
      overview: { marker: 'overview' },
      sections: {
        intelligence: { available: true, data: { marker: 'intelligence' } },
      },
    });
    expect(reads.read).toHaveBeenCalledWith(storeId, { fresh: true });
  });

  it('keeps historical analytics available when intelligence fails', async () => {
    const reads = intelligence({
      read: vi.fn().mockRejectedValue(new Error('rule engine unavailable')),
    });

    const result = await new ReportWorkspace(analytics(), reads).read(
      storeId,
      { days: 30 },
      now,
    );

    expect(result.overview).toEqual({ marker: 'overview' });
    expect(result.sections.intelligence).toEqual({ available: false, data: null });
  });

  it('does not hide a primary analytics failure behind an optional section', async () => {
    const workspace = new ReportWorkspace(
      analytics({ overview: vi.fn().mockRejectedValue(new Error('analytics unavailable')) }),
      intelligence(),
    );

    await expect(workspace.read(storeId, { days: 30 }, now)).rejects.toThrow(
      'analytics unavailable',
    );
  });
});
