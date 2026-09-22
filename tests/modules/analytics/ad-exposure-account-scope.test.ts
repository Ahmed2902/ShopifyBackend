import { describe, expect, it } from 'vitest';
import { scopeSelectedMetaAccount } from '../../../src/modules/analytics/ad-exposure.controller.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;

function storeContext(): StoreContext {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    currencyCode: 'USD',
    ianaTimezone: 'UTC',
    inventoryIntelligenceMode: 'DISABLED',
    shopifyConnection: null,
    metaConnection: {
      status: 'ACTIVE',
      selectedAdAccountIds: ['act_101', 'act_202'],
    },
  } as StoreContext;
}

describe('Ad Exposure selected account scope', () => {
  it('narrows exposure reads to exactly one selected account', () => {
    const scoped = scopeSelectedMetaAccount(storeContext(), 'act_202');

    expect(scoped.metaConnection?.selectedAdAccountIds).toEqual(['act_202']);
  });

  it('rejects an account that is not selected for the store', () => {
    expect(() => scopeSelectedMetaAccount(storeContext(), 'act_not_selected')).toThrowError(
      expect.objectContaining({ code: 'META_AD_ACCOUNT_NOT_SELECTED', statusCode: 400 }),
    );
  });
});
