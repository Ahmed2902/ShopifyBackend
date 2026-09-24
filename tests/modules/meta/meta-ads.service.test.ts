import { describe, expect, it, vi } from 'vitest';
import type { AdvertisingProjectionRepository } from '../../../src/modules/advertising/advertising-projection.repository.js';
import type { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';
import { MetaAdsService } from '../../../src/modules/meta/ads/meta-ads.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  accessToken: 'token',
  apiVersion: 'v26.0',
};

const accountProfile = {
  id: 'act_101',
  accountId: '101',
  name: 'Primary',
  accountStatus: 1,
  currency: 'USD',
  timezoneName: 'America/New_York',
  timezoneId: 1,
  timezoneOffsetHoursUtc: -4,
  amountSpentMinor: 1000n,
  balanceMinor: 0n,
  spendCapMinor: null,
  business: { id: 'biz_1', name: 'Business' },
  raw: { id: 'act_101' },
};

const campaign = {
  id: 'cmp_1',
  name: 'Campaign',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
};
const adSet = {
  id: 'set_1',
  campaign_id: 'cmp_1',
  name: 'Ad Set',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
  learning_stage_info: { status: 'LEARNING' },
};
const creative = {
  id: 'creative_1',
  name: 'Creative',
  link_url: 'https://store.example/products/hoodie',
};
const ad = {
  id: 'ad_1',
  campaign_id: 'cmp_1',
  adset_id: 'set_1',
  name: 'Ad',
  effective_status: 'ACTIVE',
  creative: { id: 'creative_1' },
};

function build(options?: { badAdSetParent?: boolean; empty?: boolean }) {
  const repository = {
    findAccount: vi.fn().mockResolvedValue({ id: 'local-account', metaAccountId: 'act_101' }),
    updateAccountProfile: vi.fn().mockResolvedValue(undefined),
    upsertCampaign: vi.fn().mockResolvedValue({ id: 'local-cmp', metaCampaignId: 'cmp_1' }),
    upsertAdSet: vi.fn().mockResolvedValue({ id: 'local-set', metaAdSetId: 'set_1' }),
    upsertCreative: vi.fn().mockResolvedValue({ id: 'local-creative', metaCreativeId: 'creative_1' }),
    upsertAd: vi.fn().mockResolvedValue({ id: 'local-ad', metaAdId: 'ad_1' }),
    softDeleteMissing: vi.fn().mockResolvedValue({ campaigns: 1, adSets: 2, creatives: 0, ads: 3 }),
    markAccountSynced: vi.fn().mockResolvedValue(undefined),
  } as unknown as MetaAdsRepository;

  const collections = options?.empty
    ? [[], [], [], []]
    : [
        [campaign],
        [{ ...adSet, campaign_id: options?.badAdSetParent ? 'missing' : 'cmp_1' }],
        [creative],
        [ad],
      ];
  let collectionIndex = 0;
  const apiService = {
    getAdAccount: vi.fn().mockResolvedValue(accountProfile),
    collectGraphPages: vi.fn().mockImplementation(async () => collections[collectionIndex++]),
  } as unknown as MetaApiService;
  const canonicalProjection = {
    projectMetaHierarchy: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdvertisingProjectionRepository;

  return {
    repository,
    apiService,
    canonicalProjection,
    service: new MetaAdsService(repository, apiService, canonicalProjection),
  };
}

describe('MetaAdsService', () => {
  it('persists a complete hierarchy snapshot and soft-deletes only after all provider reads succeed', async () => {
    const { repository, canonicalProjection, service } = build();

    const result = await service.syncSelectedAccount(context, 'act_101');

    expect(repository.updateAccountProfile).toHaveBeenCalledTimes(1);
    expect(repository.upsertCampaign).toHaveBeenCalledWith('local-account', expect.objectContaining({ id: 'cmp_1' }));
    expect(repository.upsertAdSet).toHaveBeenCalledWith(
      'local-account',
      'local-cmp',
      expect.objectContaining({ id: 'set_1' }),
    );
    expect(repository.upsertCreative).toHaveBeenCalledWith(
      'local-account',
      expect.objectContaining({ id: 'creative_1' }),
    );
    expect(repository.upsertAd).toHaveBeenCalledWith(
      'local-account',
      'local-cmp',
      'local-set',
      'local-creative',
      expect.objectContaining({ id: 'ad_1' }),
    );
    expect(repository.softDeleteMissing).toHaveBeenCalledWith('local-account', {
      campaignIds: ['cmp_1'],
      adSetIds: ['set_1'],
      creativeIds: ['creative_1'],
      adIds: ['ad_1'],
    });
    expect(repository.markAccountSynced).toHaveBeenCalledWith('local-account');
    expect(canonicalProjection.projectMetaHierarchy).toHaveBeenCalledWith('local-account');
    expect(result).toMatchObject({
      recordsRead: 5,
      recordsWritten: 11,
      breakdown: {
        adAccounts: 1,
        campaigns: 1,
        adSets: 1,
        creatives: 1,
        ads: 1,
        softDeletedCampaigns: 1,
        softDeletedAdSets: 2,
        softDeletedCreatives: 0,
        softDeletedAds: 3,
      },
    });
    expect(result.insightHierarchy.campaigns.get('cmp_1')).toBe('local-cmp');
    expect(result.insightHierarchy.adSets.get('set_1')).toBe('local-set');
    expect(result.insightHierarchy.ads.get('ad_1')).toBe('local-ad');
    expect(result.insightHierarchy.adCreatives.get('ad_1')).toEqual({
      creativeId: 'local-creative',
      metaUpdatedAt: null,
    });
    expect(result.insightHierarchy.observedAt).toBeInstanceOf(Date);
  });

  it('rejects inconsistent parent references before mutating local hierarchy rows', async () => {
    const { repository, canonicalProjection, service } = build({ badAdSetParent: true });

    await expect(service.syncSelectedAccount(context, 'act_101')).rejects.toMatchObject({
      code: 'META_HIERARCHY_INCONSISTENT',
    });
    expect(repository.updateAccountProfile).not.toHaveBeenCalled();
    expect(repository.upsertCampaign).not.toHaveBeenCalled();
    expect(repository.softDeleteMissing).not.toHaveBeenCalled();
    expect(canonicalProjection.projectMetaHierarchy).not.toHaveBeenCalled();
  });

  it('treats an empty completed provider snapshot as deletion of all current hierarchy rows', async () => {
    const { repository, canonicalProjection, service } = build({ empty: true });

    await service.syncSelectedAccount(context, 'act_101');

    expect(repository.softDeleteMissing).toHaveBeenCalledWith('local-account', {
      campaignIds: [],
      adSetIds: [],
      creativeIds: [],
      adIds: [],
    });
    expect(repository.upsertCampaign).not.toHaveBeenCalled();
    expect(canonicalProjection.projectMetaHierarchy).toHaveBeenCalledWith('local-account');
  });

  it('requires the account to have been explicitly configured locally', async () => {
    const { repository, service } = build();
    vi.mocked(repository.findAccount).mockResolvedValue(null);

    await expect(service.syncSelectedAccount(context, 'act_missing')).rejects.toMatchObject({
      code: 'META_AD_ACCOUNT_NOT_CONFIGURED',
    });
  });
});
