import { describe, expect, it } from 'vitest';
import { dashboardCacheKey } from '../../../src/modules/analytics/dashboard.controller.js';
import { reportCacheKey } from '../../../src/modules/analytics/report.controller.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const baseQuery = { days: 30, from: '2026-08-01', to: '2026-08-30' };

describe('account-scoped analytics cache identities', () => {
  it('keeps dashboard cache entries isolated by Meta account', () => {
    const allAccounts = dashboardCacheKey(storeId, baseQuery);
    const firstAccount = dashboardCacheKey(storeId, { ...baseQuery, accountId: 'act_101' });
    const secondAccount = dashboardCacheKey(storeId, { ...baseQuery, accountId: 'act_202' });

    expect(firstAccount).not.toBe(allAccounts);
    expect(secondAccount).not.toBe(allAccounts);
    expect(firstAccount).not.toBe(secondAccount);
  });

  it('keeps historical report cache entries isolated by Meta account', () => {
    const allAccounts = reportCacheKey(storeId, baseQuery);
    const firstAccount = reportCacheKey(storeId, { ...baseQuery, accountId: 'act_101' });
    const secondAccount = reportCacheKey(storeId, { ...baseQuery, accountId: 'act_202' });

    expect(firstAccount).not.toBe(allAccounts);
    expect(secondAccount).not.toBe(allAccounts);
    expect(firstAccount).not.toBe(secondAccount);
  });
});
