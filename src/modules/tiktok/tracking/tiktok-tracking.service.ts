import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { TikTokRepository } from '../tiktok.repository.js';
import { TikTokApiService } from '../shared/tiktok-api.service.js';
import { TikTokAuthService } from '../shared/tiktok-auth.service.js';
import { TikTokTrackingRepository } from './tiktok-tracking.repository.js';
import { TikTokTrackingProvider, trackingPlan } from './tiktok-tracking.provider.js';
import { manualTemplate } from './tiktok-tracking.params.js';
import type { TikTokTrackingApplyInput } from './tiktok-tracking.schema.js';
import { z } from 'zod';

const receiptSchema = z.object({
  storeId: z.string(),
  connectionId: z.string(),
  expiresAt: z.number(),
  ads: z.array(z.object({ id: z.string(), advertiserId: z.string(), hash: z.string() })).max(50),
});
type Receipt = z.infer<typeof receiptSchema>;
const sign = (payload: string) =>
  createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`tiktok-tracking-preview:v1:${payload}`)
    .digest('base64url');
function token(receipt: Receipt) {
  const payload = Buffer.from(JSON.stringify(receipt)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function decode(value: string | undefined): Receipt {
  try {
    const [payload, signature, extra] = (value ?? '').split('.');
    if (
      !payload ||
      !signature ||
      extra ||
      signature.length !== sign(payload).length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))
    )
      throw new Error();
    const receipt = receiptSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (receipt.expiresAt <= Date.now()) throw new Error();
    return receipt;
  } catch {
    throw new AppError(
      'Tracking preview expired or is invalid. Create a new preview.',
      409,
      'TIKTOK_TRACKING_PREVIEW_REQUIRED',
    );
  }
}
export class TikTokTrackingService {
  constructor(
    private readonly repository = new TikTokTrackingRepository(),
    private readonly auth = (() => {
      const repo = new TikTokRepository();
      return new TikTokAuthService(repo, new TikTokApiService());
    })(),
    private readonly provider = new TikTokTrackingProvider(),
  ) {}
  manualConfiguration() {
    return {
      mode: 'MANUAL' as const,
      urlParameters: manualTemplate(),
      smartPlusUrlParameters: manualTemplate(true),
      requiredTikTokPermission: null,
      note: 'Add these parameters alongside existing URL parameters. Standard ads expose creative IDs; Smart+ also exposes the ad bundle ID.',
    };
  }
  async audit(storeId: string) {
    const context = await this.auth.getApiContext(storeId);
    const records = await this.repository.findAds(storeId, context.selectedAdvertiserIds);
    const ads = records.slice(0, 1000).map((ad) => {
      let status: 'EXACT' | 'PARTIAL' | 'MISSING' = 'MISSING';
      let supported = true;
      try {
        const plan = trackingPlan(ad, ad.rawJson);
        status = plan.status;
      } catch {
        supported = false;
      }
      return {
        tiktokAdId: ad.tiktokAdId,
        name: ad.name,
        advertiserId: ad.advertiser.advertiserId,
        campaignId: ad.campaign.tiktokCampaignId,
        adGroupId: ad.adGroup.tiktokAdGroupId,
        trackingStatus: status,
        automaticSupported: supported,
        automaticSkipReason: supported ? null : 'MANUAL_REQUIRED',
      };
    });
    const exact = ads.filter((ad) => ad.trackingStatus === 'EXACT').length;
    const partial = ads.filter((ad) => ad.trackingStatus === 'PARTIAL').length;
    return {
      manualConfiguration: this.manualConfiguration(),
      automaticPermissionStatus: 'PROVIDER_CHECK_REQUIRED' as const,
      coverage: {
        total: ads.length,
        exact,
        partial,
        missing: ads.length - exact - partial,
        exactPercent: ads.length ? Number(((exact / ads.length) * 100).toFixed(1)) : 0,
        truncated: records.length > 1000,
      },
      ads,
    };
  }
  async apply(storeId: string, input: TikTokTrackingApplyInput) {
    const context = await this.auth.getApiContext(storeId);
    const records = await this.repository.findAds(storeId, context.selectedAdvertiserIds);
    const requested = new Set(input.adIds);
    const ads = records.filter((ad) => requested.has(ad.tiktokAdId));
    if (requested.size !== input.adIds.length || ads.length !== requested.size)
      throw new AppError(
        'Selected ads are not available in this store’s selected advertisers. Refresh the ad list.',
        400,
        'TIKTOK_AD_NOT_ACCESSIBLE',
      );
    const receipt = input.dryRun ? null : decode(input.previewToken);
    if (
      receipt &&
      (receipt.storeId !== storeId ||
        receipt.connectionId !== context.connectionId ||
        receipt.ads.length !== ads.length ||
        ads.some(
          (ad) =>
            !receipt.ads.some(
              (p) => p.id === ad.tiktokAdId && p.advertiserId === ad.advertiser.advertiserId,
            ),
        ))
    )
      throw new AppError(
        'The selected ads differ from the preview. Preview again.',
        409,
        'TIKTOK_TRACKING_PREVIEW_REQUIRED',
      );
    const planned: Receipt['ads'] = [];
    const results: Array<{
      tiktokAdId: string;
      status: string;
      currentUrls?: string[];
      nextUrls?: string[];
      errorCode?: string;
      message?: string;
    }> = [];
    for (const ad of ads) {
      try {
        if (input.dryRun) {
          const plan = await this.provider.read(context, ad);
          results.push({
            tiktokAdId: ad.tiktokAdId,
            status: plan.status === 'EXACT' ? 'SKIPPED' : 'PLANNED',
            currentUrls: plan.originalUrls,
            nextUrls: plan.nextUrls,
          });
          planned.push({
            id: ad.tiktokAdId,
            advertiserId: ad.advertiser.advertiserId,
            hash: plan.hash,
          });
        } else {
          results.push({
            tiktokAdId: ad.tiktokAdId,
            status: await this.provider.install(
              context,
              ad,
              receipt!.ads.find((p) => p.id === ad.tiktokAdId)!.hash,
            ),
          });
        }
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'TIKTOK_REQUEST_FAILED';
        results.push({
          tiktokAdId: ad.tiktokAdId,
          status: code === 'TIKTOK_TRACKING_UNSUPPORTED' ? 'MANUAL_REQUIRED' : 'FAILED',
          errorCode: code,
          message:
            code === 'TIKTOK_TRACKING_SNAPSHOT_STALE'
              ? 'This ad changed. Sync or preview again.'
              : code === 'TIKTOK_TRACKING_UNSUPPORTED'
                ? 'Use the manual template for this ad format.'
                : 'TikTok tracking could not be verified. Check ad update permission, reconnect, and refresh before retrying.',
        });
      }
    }
    return {
      mode: input.dryRun ? ('DRY_RUN' as const) : ('AUTOMATIC' as const),
      providerReviewMayBeRequired: true,
      automaticMutationScope: 'tracking parameters only' as const,
      previewToken:
        input.dryRun && planned.length === ads.length
          ? token({
              storeId,
              connectionId: context.connectionId,
              expiresAt: Date.now() + 10 * 60_000,
              ads: planned,
            })
          : null,
      results,
      manualConfiguration: this.manualConfiguration(),
      requiresHierarchyResync: !input.dryRun,
    };
  }
}
export const tiktokTrackingService = new TikTokTrackingService();
