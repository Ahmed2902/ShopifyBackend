import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import { PerformanceAnalyticsWorkspace } from '../../../src/modules/analytics/performance-analytics.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('cross-channel performance account scope', () => {
  it('fails closed instead of mixing account-scoped ads with store-scoped commerce', async () => {
    const repository = {
      getStoreContext: vi.fn(),
    } as unknown as AnalyticsRepository;
    const workspace = new PerformanceAnalyticsWorkspace(repository);

    await expect(
      workspace.daily(storeId, { days: 30, accountId: 'act_202' }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_SCOPED_PERFORMANCE_UNSUPPORTED',
      statusCode: 400,
    });
    expect(repository.getStoreContext).not.toHaveBeenCalled();
  });
});
