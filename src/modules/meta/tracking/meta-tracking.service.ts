import { AppError } from '../../../errors/app-error.js';
import { MetaRepository } from '../meta.repository.js';
import { MetaApiService } from '../shared/meta-api.service.js';
import { MetaAuthService } from '../shared/meta-auth.service.js';
import { MetaTrackingProvider } from './meta-tracking.provider.js';
import { MetaTrackingRepository, type MetaTrackingAd } from './meta-tracking.repository.js';
import type { MetaTrackingApplyInput } from './meta-tracking.schema.js';

const TRACKING_VALUES = {
  stride_meta_campaign_id: '{{campaign.id}}',
  stride_meta_adset_id: '{{adset.id}}',
  stride_meta_ad_id: '{{ad.id}}',
} as const;

export const STRIDE_META_TRACKING_TEMPLATE = Object.entries(TRACKING_VALUES)
  .map(([key, value]) => `${key}=${value}`)
  .join('&');

type TrackingStatus = 'EXACT' | 'PARTIAL' | 'MISSING';

function parseUrlTags(value: string | null): URLSearchParams {
  return new URLSearchParams((value ?? '').trim().replace(/^\?/, ''));
}

function trackingStatus(value: string | null): TrackingStatus {
  const params = parseUrlTags(value);
  const matches = Object.entries(TRACKING_VALUES).map(
    ([key, expected]) => params.get(key) === expected,
  );
  if (matches.every(Boolean)) return 'EXACT';
  if (Object.keys(TRACKING_VALUES).some((key) => params.has(key))) return 'PARTIAL';
  return 'MISSING';
}

function mergeTrackingTags(value: string | null): string {
  const current = (value ?? '').trim().replace(/^\?/, '');
  const preserved = current
    .split('&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.split('=', 1)[0];
      return !Object.prototype.hasOwnProperty.call(TRACKING_VALUES, key);
    });
  return [...preserved, STRIDE_META_TRACKING_TEMPLATE].join('&');
}

function automationSupport(ad: MetaTrackingAd): { supported: boolean; reason: string | null } {
  if (!ad.creative) return { supported: false, reason: 'CREATIVE_MISSING' };
  if (ad.adSet.isDynamicCreative || ad.creative.assetFeedSpec) {
    return { supported: false, reason: 'DYNAMIC_CREATIVE' };
  }
  if (!ad.creative.objectStoryId && !ad.creative.objectStorySpec) {
    return { supported: false, reason: 'UNSUPPORTED_CREATIVE_SHAPE' };
  }
  return { supported: true, reason: null };
}

function auditAd(ad: MetaTrackingAd) {
  const status = trackingStatus(ad.creative?.urlTags ?? null);
  const support = automationSupport(ad);
  return {
    metaAdId: ad.metaAdId,
    name: ad.name,
    metaCampaignId: ad.campaign.metaCampaignId,
    metaAdSetId: ad.adSet.metaAdSetId,
    metaAdAccountId: ad.adAccount.metaAccountId,
    configuredStatus: ad.configuredStatus,
    effectiveStatus: ad.effectiveStatus,
    trackingStatus: status,
    currentUrlTags: ad.creative?.urlTags ?? null,
    automaticSupported: support.supported,
    automaticSkipReason: support.reason,
  };
}

export class MetaTrackingService {
  constructor(
    private readonly repository: MetaTrackingRepository = new MetaTrackingRepository(),
    private readonly authService: MetaAuthService = (() => {
      const metaRepository = new MetaRepository();
      return new MetaAuthService(metaRepository, new MetaApiService(metaRepository));
    })(),
    private readonly provider: MetaTrackingProvider = new MetaTrackingProvider(),
  ) {}

  startPermissionUpgrade(userId: string, storeId: string) {
    return this.authService.startAdsManagementUpgrade(userId, storeId);
  }

  manualConfiguration() {
    return {
      mode: 'MANUAL' as const,
      urlParameters: STRIDE_META_TRACKING_TEMPLATE,
      requiredMetaPermission: null,
      parameters: {
        campaign: 'stride_meta_campaign_id={{campaign.id}}',
        adSet: 'stride_meta_adset_id={{adset.id}}',
        ad: 'stride_meta_ad_id={{ad.id}}',
      },
      note: 'Existing merchant URL parameters can remain; add the Stride parameters alongside them.',
    };
  }

  async audit(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const ads = await this.repository.findAds(storeId);
    const items = ads.map(auditAd);
    const exact = items.filter((item) => item.trackingStatus === 'EXACT').length;
    const partial = items.filter((item) => item.trackingStatus === 'PARTIAL').length;
    const missing = items.length - exact - partial;

    return {
      requiredMetaPermissionForAutomaticSetup: 'ads_management' as const,
      managementPermissionGranted: context.scopes.includes('ads_management'),
      manualConfiguration: this.manualConfiguration(),
      coverage: {
        total: items.length,
        exact,
        partial,
        missing,
        exactPercent: items.length === 0 ? 0 : Number(((exact / items.length) * 100).toFixed(1)),
      },
      ads: items,
    };
  }

  async apply(storeId: string, input: MetaTrackingApplyInput) {
    const context = await this.authService.getApiContext(storeId);
    if (!context.scopes.includes('ads_management')) {
      throw new AppError(
        'Meta ads_management permission is required for automatic tracking setup',
        403,
        'META_ADS_MANAGEMENT_REQUIRED',
        { manualConfiguration: this.manualConfiguration() },
      );
    }

    const ads = await this.repository.findAds(storeId);
    const requestedIds = input.adIds ? new Set(input.adIds) : null;
    const selected = requestedIds ? ads.filter((ad) => requestedIds.has(ad.metaAdId)) : ads;

    if (requestedIds) {
      const found = new Set(selected.map((ad) => ad.metaAdId));
      const missing = [...requestedIds].filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new AppError(
          `Meta ads are not available to this store: ${missing.join(', ')}`,
          400,
          'META_AD_NOT_ACCESSIBLE',
        );
      }
    }

    const results: Array<Record<string, unknown>> = [];
    for (const ad of selected) {
      const currentStatus = trackingStatus(ad.creative?.urlTags ?? null);
      if (currentStatus === 'EXACT') {
        results.push({ metaAdId: ad.metaAdId, status: 'SKIPPED', reason: 'ALREADY_CONFIGURED' });
        continue;
      }

      const support = automationSupport(ad);
      if (!support.supported) {
        results.push({
          metaAdId: ad.metaAdId,
          status: 'MANUAL_REQUIRED',
          reason: support.reason,
          urlParameters: STRIDE_META_TRACKING_TEMPLATE,
        });
        continue;
      }

      const nextUrlTags = mergeTrackingTags(ad.creative?.urlTags ?? null);
      if (input.dryRun) {
        results.push({
          metaAdId: ad.metaAdId,
          status: 'PLANNED',
          currentUrlTags: ad.creative?.urlTags ?? null,
          nextUrlTags,
        });
        continue;
      }

      try {
        const applied = await this.provider.cloneCreativeAndAssign(context, ad, nextUrlTags);
        results.push({
          metaAdId: ad.metaAdId,
          status: 'UPDATED',
          newCreativeId: applied.newCreativeId,
          nextUrlTags,
          requiresHierarchyResync: true,
        });
      } catch (error) {
        results.push({
          metaAdId: ad.metaAdId,
          status: 'FAILED',
          errorCode: error instanceof AppError ? error.code : 'META_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'Meta tracking update failed',
          details: error instanceof AppError ? error.details ?? null : null,
          manualFallback: STRIDE_META_TRACKING_TEMPLATE,
        });
      }
    }

    return {
      mode: input.dryRun ? ('DRY_RUN' as const) : ('AUTOMATIC' as const),
      providerReviewMayBeRequired: true,
      automaticMutationScope: 'tracking parameters only' as const,
      results,
      manualConfiguration: this.manualConfiguration(),
    };
  }
}

export const metaTrackingService = new MetaTrackingService();
