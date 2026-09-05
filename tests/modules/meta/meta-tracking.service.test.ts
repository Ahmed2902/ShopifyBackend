import { describe, expect, it, vi } from 'vitest';
import type { MetaAuthService } from '../../../src/modules/meta/shared/meta-auth.service.js';
import type { MetaTrackingProvider } from '../../../src/modules/meta/tracking/meta-tracking.provider.js';
import type {
  MetaTrackingAd,
  MetaTrackingRepository,
} from '../../../src/modules/meta/tracking/meta-tracking.repository.js';
import {
  MetaTrackingService,
  STRIDE_META_TRACKING_TEMPLATE,
} from '../../../src/modules/meta/tracking/meta-tracking.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildAd(overrides?: Partial<MetaTrackingAd>): MetaTrackingAd {
  return {
    metaAdId: '3003',
    name: 'Creative A',
    configuredStatus: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    adAccount: { metaAccountId: 'act_9009' },
    campaign: { metaCampaignId: '1001' },
    adSet: { metaAdSetId: '2002', isDynamicCreative: false },
    creative: {
      metaCreativeId: '4004',
      name: 'Creative A source',
      objectStoryId: '123_456',
      objectStorySpec: null,
      assetFeedSpec: null,
      degreesOfFreedomSpec: null,
      urlTags: 'utm_source=facebook',
    },
    ...overrides,
  } as MetaTrackingAd;
}

function buildService(input?: { scopes?: string[]; ads?: MetaTrackingAd[] }) {
  const repository = {
    findAds: vi.fn().mockResolvedValue(input?.ads ?? [buildAd()]),
  } as unknown as MetaTrackingRepository;
  const authService = {
    startAdsManagementUpgrade: vi.fn().mockResolvedValue({ authorizationUrl: 'https://meta.test' }),
    getApiContext: vi.fn().mockResolvedValue({
      storeId,
      connectionId: 'connection-id',
      accessToken: 'access-token',
      apiVersion: 'v25.0',
      scopes: input?.scopes ?? ['ads_read'],
      metaBusinessId: null,
      selectedAdAccountIds: ['act_9009'],
      selectedCatalogIds: [],
    }),
  } as unknown as MetaAuthService;
  const provider = {
    cloneCreativeAndAssign: vi.fn().mockResolvedValue({ newCreativeId: '5005' }),
  } as unknown as MetaTrackingProvider;

  return {
    repository,
    authService,
    provider,
    service: new MetaTrackingService(repository, authService, provider),
  };
}

describe('MetaTrackingService', () => {
  it('audits exact tracking coverage without requiring write permission', async () => {
    const exact = buildAd({
      creative: {
        ...buildAd().creative!,
        urlTags: STRIDE_META_TRACKING_TEMPLATE,
      },
    });
    const partial = buildAd({
      metaAdId: '3004',
      creative: {
        ...buildAd().creative!,
        urlTags: 'stride_meta_ad_id={{ad.id}}',
      },
    });
    const { service } = buildService({ ads: [exact, partial, buildAd({ metaAdId: '3005' })] });

    await expect(service.audit(storeId)).resolves.toMatchObject({
      managementPermissionGranted: false,
      coverage: { total: 3, exact: 1, partial: 1, missing: 1, exactPercent: 33.3 },
    });
  });

  it('returns the manual configuration when automatic permission is not granted', async () => {
    const { service } = buildService({ scopes: ['ads_read'] });

    await expect(service.apply(storeId, { dryRun: false })).rejects.toMatchObject({
      statusCode: 403,
      code: 'META_ADS_MANAGEMENT_REQUIRED',
      details: {
        manualConfiguration: {
          urlParameters: STRIDE_META_TRACKING_TEMPLATE,
        },
      },
    });
  });

  it('dry-runs a safe creative update while preserving merchant URL tags', async () => {
    const { provider, service } = buildService({ scopes: ['ads_read', 'ads_management'] });

    const result = await service.apply(storeId, { dryRun: true });

    expect(provider.cloneCreativeAndAssign).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      expect.objectContaining({
        metaAdId: '3003',
        status: 'PLANNED',
        nextUrlTags: `utm_source=facebook&${STRIDE_META_TRACKING_TEMPLATE}`,
      }),
    ]);
  });

  it('uses manual fallback for dynamic creatives instead of mutating them', async () => {
    const dynamic = buildAd({
      adSet: { metaAdSetId: '2002', isDynamicCreative: true },
    });
    const { provider, service } = buildService({
      scopes: ['ads_read', 'ads_management'],
      ads: [dynamic],
    });

    const result = await service.apply(storeId, { dryRun: false });

    expect(provider.cloneCreativeAndAssign).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      expect.objectContaining({
        metaAdId: '3003',
        status: 'MANUAL_REQUIRED',
        reason: 'DYNAMIC_CREATIVE',
        urlParameters: STRIDE_META_TRACKING_TEMPLATE,
      }),
    ]);
  });

  it('applies tracking only after explicit write permission and merchant action', async () => {
    const ad = buildAd();
    const { provider, service } = buildService({
      scopes: ['ads_read', 'ads_management'],
      ads: [ad],
    });

    const result = await service.apply(storeId, { adIds: ['3003'], dryRun: false });

    expect(provider.cloneCreativeAndAssign).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['ads_read', 'ads_management'] }),
      ad,
      `utm_source=facebook&${STRIDE_META_TRACKING_TEMPLATE}`,
    );
    expect(result.results).toEqual([
      expect.objectContaining({
        metaAdId: '3003',
        status: 'UPDATED',
        newCreativeId: '5005',
        requiresHierarchyResync: true,
      }),
    ]);
  });
});
