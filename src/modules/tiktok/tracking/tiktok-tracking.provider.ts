import { AppError } from '../../../errors/app-error.js';
import { TikTokApiService } from '../shared/tiktok-api.service.js';
import type { TikTokApiContext } from '../tiktok.types.js';
import { asRecord, asString } from '../tiktok.utils.js';
import type { TikTokTrackingAd } from './tiktok-tracking.repository.js';
import {
  cleanUrl,
  desiredParameters,
  parameters,
  removeOwnedUrlParameters,
  snapshotHash,
  trackingStatus,
  TIKTOK_NATIVE_UTMS,
} from './tiktok-tracking.params.js';

export function isSmartAd(ad: TikTokTrackingAd) {
  return Boolean(asRecord(ad.rawJson).smart_plus_ad_id);
}
export function trackingPlan(ad: TikTokTrackingAd, raw: unknown) {
  const r = asRecord(raw);
  const smart = isSmartAd(ad);
  const id = asString(smart ? r.smart_plus_ad_id : r.ad_id);
  if (
    id !== ad.tiktokAdId ||
    asString(r.adgroup_id ?? r.smart_plus_adgroup_id) !== ad.adGroup.tiktokAdGroupId ||
    asString(r.campaign_id ?? r.smart_plus_campaign_id) !== ad.campaign.tiktokCampaignId ||
    (r.advertiser_id != null && asString(r.advertiser_id) !== ad.advertiser.advertiserId)
  )
    throw new AppError(
      'Sync this ad again before installing tracking.',
      409,
      'TIKTOK_TRACKING_SNAPSHOT_STALE',
    );
  if (
    !smart &&
    (ad.campaign.isSmartPerformance ||
      r.creative_material_mode === 'DYNAMIC' ||
      r.is_aco === true ||
      Array.isArray(r.landing_page_urls) ||
      Array.isArray(r.landing_page_url_list))
  )
    throw new AppError('This ad format needs manual setup.', 409, 'TIKTOK_TRACKING_UNSUPPORTED');
  const configuration = asRecord(r.ad_configuration);
  const originalUrls = smart
    ? (Array.isArray(r.landing_page_url_list) ? r.landing_page_url_list : []).map((v) => {
        if (typeof v === 'string') return cleanUrl(v);
        const item = asRecord(v);
        if (Object.keys(item).some((k) => k !== 'landing_page_url'))
          throw new AppError(
            'This destination list needs manual setup.',
            409,
            'TIKTOK_TRACKING_UNSUPPORTED',
          );
        return cleanUrl(item.landing_page_url);
      })
    : [cleanUrl(r.landing_page_url)];
  if (!originalUrls.length || originalUrls.length > 20)
    throw new AppError(
      'This ad needs a supported website destination.',
      409,
      'TIKTOK_TRACKING_UNSUPPORTED',
    );
  const current = parameters(smart ? configuration.utm_params : r.utm_params);
  const desired = desiredParameters(
    ad.campaign.tiktokCampaignId,
    ad.adGroup.tiktokAdGroupId,
    ad.tiktokAdId,
  );
  const observed = { ...desired };
  if (
    !smart &&
    !originalUrls.some((url) => new URL(url).searchParams.has('metrico_tiktok_ad_id')) &&
    !current.some((p) => p.key === 'metrico_tiktok_ad_id')
  )
    delete observed.metrico_tiktok_ad_id;
  const status = trackingStatus(originalUrls, current, observed);
  if (status !== 'EXACT' && current.some((p) => Object.hasOwn(desired, p.key)))
    throw new AppError(
      'Existing platform tracking fields need manual setup.',
      409,
      'TIKTOK_TRACKING_UNSUPPORTED',
    );
  const nextUrls = originalUrls.map((url) => {
    const clean = removeOwnedUrlParameters(url, desired);
    const hash = clean.indexOf('#');
    const base = hash < 0 ? clean : clean.slice(0, hash);
    const fragment = hash < 0 ? '' : clean.slice(hash);
    const existing = new URL(url).searchParams;
    const missingUtms = Object.fromEntries(Object.entries(TIKTOK_NATIVE_UTMS).filter(([key]) => !existing.has(key) && !current.some(p => p.key === key)));
    // Use the ad's known campaign ID for automatic setup; preserve merchant labels.
    if (Object.hasOwn(missingUtms, 'utm_id')) missingUtms.utm_id = ad.campaign.tiktokCampaignId;
    return (
      base +
      (base.includes('?') ? '&' : '?') +
      Object.entries({ ...missingUtms, ...desired })
        .map(([k, v]) => `${k}=${v}`)
        .join('&') +
      fragment
    );
  });
  const snapshot = {
    id,
    smart,
    originalUrls,
    current,
    campaignId: ad.campaign.tiktokCampaignId,
    groupId: ad.adGroup.tiktokAdGroupId,
  };
  return {
    smart,
    originalUrls,
    nextUrls,
    currentParameters: current,
    status,
    hash: snapshotHash(snapshot),
  };
}
export class TikTokTrackingProvider {
  constructor(private readonly api = new TikTokApiService()) {}
  async read(context: TikTokApiContext, ad: TikTokTrackingAd) {
    const smart = isSmartAd(ad);
    const data = await this.api.request<Record<string, unknown>>(
      context,
      smart ? 'smart_plus/ad/get' : 'ad/get',
      {
        query: {
          advertiser_id: ad.advertiser.advertiserId,
          filtering: smart ? { smart_plus_ad_ids: [ad.tiktokAdId] } : { ad_ids: [ad.tiktokAdId] },
          page: 1,
          page_size: 20,
        },
      },
    );
    const records = Array.isArray(data.list) ? data.list : [];
    const found = records.find(
      (raw) => asString(asRecord(raw)[smart ? 'smart_plus_ad_id' : 'ad_id']) === ad.tiktokAdId,
    );
    if (!found)
      throw new AppError(
        'TikTok ad is no longer accessible. Sync ads again.',
        409,
        'TIKTOK_TRACKING_SNAPSHOT_STALE',
      );
    return trackingPlan(ad, found);
  }
  async install(context: TikTokApiContext, ad: TikTokTrackingAd, expectedHash: string) {
    const plan = await this.read(context, ad);
    if (plan.status === 'EXACT') return 'SKIPPED' as const;
    if (plan.hash !== expectedHash)
      throw new AppError(
        'This ad changed after preview. Preview again before installing.',
        409,
        'TIKTOK_TRACKING_SNAPSHOT_STALE',
      );
    const body = plan.smart
      ? {
          advertiser_id: ad.advertiser.advertiserId,
          smart_plus_ad_id: ad.tiktokAdId,
          landing_page_url_list: plan.nextUrls.map((landing_page_url) => ({ landing_page_url })),
        }
      : {
          advertiser_id: ad.advertiser.advertiserId,
          adgroup_id: ad.adGroup.tiktokAdGroupId,
          patch_update: true,
          creatives: [{ ad_id: ad.tiktokAdId, landing_page_url: plan.nextUrls[0] }],
        };
    await this.api.request(context, plan.smart ? 'smart_plus/ad/update' : 'ad/update', {
      method: 'POST',
      body,
      retry: false,
    });
    const verified = await this.read(context, ad);
    if (
      verified.status !== 'EXACT' ||
      JSON.stringify(verified.originalUrls) !== JSON.stringify(plan.nextUrls) ||
      JSON.stringify(verified.currentParameters) !== JSON.stringify(plan.currentParameters)
    )
      throw new AppError(
        'TikTok accepted the update but saved tracking could not be verified. Refresh before retrying.',
        409,
        'TIKTOK_TRACKING_VERIFY_REQUIRED',
      );
    return 'UPDATED' as const;
  }
}
