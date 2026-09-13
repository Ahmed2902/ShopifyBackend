import { beforeEach, describe, expect, it, vi } from 'vitest';

const callOrder = vi.hoisted(() => [] as string[]);
const queryRaw = vi.hoisted(() => vi.fn(async () => {
  callOrder.push('lock');
  return [{ pg_advisory_xact_lock: null }];
}));
const campaignFindUnique = vi.hoisted(() => vi.fn());
const campaignUpsert = vi.hoisted(() => vi.fn());
const accountFindUniqueOrThrow = vi.hoisted(() => vi.fn());
const enqueueRepairs = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
  $queryRaw: queryRaw,
  metaCampaign: {
    findUnique: campaignFindUnique,
    upsert: campaignUpsert,
  },
  metaAdAccount: {
    findUniqueOrThrow: accountFindUniqueOrThrow,
  },
})));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { $transaction: transaction },
}));

vi.mock('../../../src/modules/pixel/pixel-source-invalidation.js', () => ({
  enqueueMetaHierarchyPixelRepairs: enqueueRepairs,
}));

import { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';

describe('MetaAdsRepository hierarchy transition locking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    campaignFindUnique.mockImplementation(async () => {
      callOrder.push('read');
      return { deletedAt: null };
    });
    campaignUpsert.mockImplementation(async () => {
      callOrder.push('write');
      return { id: 'campaign-db', metaCampaignId: '1001' };
    });
    accountFindUniqueOrThrow.mockImplementation(async () => {
      callOrder.push('account');
      return { storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    });
    enqueueRepairs.mockImplementation(async () => {
      callOrder.push('repair');
      return 1;
    });
  });

  it('takes the account-scoped advisory lock before reading resolver state', async () => {
    const repository = new MetaAdsRepository();

    await repository.upsertCampaign('account-db', { id: '1001', name: 'Campaign renamed' });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['lock', 'read', 'write']);
    expect(enqueueRepairs).not.toHaveBeenCalled();
  });

  it('keeps resolver-changing writes and Pixel repair enqueueing inside the locked transaction', async () => {
    campaignFindUnique.mockImplementationOnce(async () => {
      callOrder.push('read');
      return { deletedAt: new Date('2026-09-12T00:00:00.000Z') };
    });
    const repository = new MetaAdsRepository();

    await repository.upsertCampaign('account-db', { id: '1001', name: 'Revived campaign' });

    expect(callOrder).toEqual(['lock', 'read', 'write', 'account', 'repair']);
    expect(enqueueRepairs).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expect.objectContaining({ $queryRaw: queryRaw }),
      { campaignIds: ['1001'] },
    );
  });
});
