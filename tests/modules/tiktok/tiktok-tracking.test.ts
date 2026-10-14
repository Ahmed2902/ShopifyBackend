import { describe, expect, it, vi } from 'vitest';
import {
  TikTokTrackingProvider,
  trackingPlan,
} from '../../../src/modules/tiktok/tracking/tiktok-tracking.provider.js';
import { TikTokTrackingService } from '../../../src/modules/tiktok/tracking/tiktok-tracking.service.js';
import type { TikTokApiService } from '../../../src/modules/tiktok/shared/tiktok-api.service.js';
import type { TikTokAuthService } from '../../../src/modules/tiktok/shared/tiktok-auth.service.js';
import type {
  TikTokTrackingRepository} from '../../../src/modules/tiktok/tracking/tiktok-tracking.repository.js';
import {
  type TikTokTrackingAd,
} from '../../../src/modules/tiktok/tracking/tiktok-tracking.repository.js';
import { tiktokTrackingApplySchema } from '../../../src/modules/tiktok/tracking/tiktok-tracking.schema.js';
import type { TikTokApiContext } from '../../../src/modules/tiktok/tiktok.types.js';
const context = {
  storeId: 'store-a',
  connectionId: 'connection-a',
  selectedAdvertiserIds: ['11'],
} as TikTokApiContext;
const raw = {
  advertiser_id: '11',
  ad_id: '44',
  campaign_id: '22',
  adgroup_id: '33',
  landing_page_url:
    'https://shop.example/products/a?utm_source=tiktok&utm_content=merchant%20value&custom=__CID__#details',
  utm_params: [{ key: 'utm_campaign', value: 'Keep me' }],
};
const ad = {
  tiktokAdId: '44',
  name: 'Test ad',
  rawJson: raw,
  landingPageUrl: raw.landing_page_url,
  advertiser: { advertiserId: '11' },
  campaign: { tiktokCampaignId: '22', isSmartPerformance: false },
  adGroup: { tiktokAdGroupId: '33' },
} as TikTokTrackingAd;
function providerHarness() {
  let live: Record<string, unknown> = { ...raw };
  const calls: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const request = vi.fn(async (_context, endpoint: string, options: Record<string, unknown>) => {
    calls.push({ endpoint, options });
    if (endpoint === 'ad/get') return { list: [live] };
    if (endpoint === 'ad/update') {
      const body = options.body as { creatives: Array<{ landing_page_url: string }> };
      live = { ...live, landing_page_url: body.creatives[0]!.landing_page_url };
      return {};
    }
    throw new Error('Unexpected endpoint');
  });
  return {
    provider: new TikTokTrackingProvider({ request } as unknown as TikTokApiService),
    calls,
    request,
    setLive: (value: Record<string, unknown>) => {
      live = value;
    },
  };
}
function serviceHarness() {
  const h = providerHarness();
  let currentContext = context;
  const findAds = vi.fn(async () => [ad]);
  const service = new TikTokTrackingService(
    { findAds } as unknown as TikTokTrackingRepository,
    { getApiContext: async () => currentContext } as unknown as TikTokAuthService,
    h.provider,
  );
  return {
    ...h,
    service,
    findAds,
    setContext: (c: TikTokApiContext) => {
      currentContext = c;
    },
  };
}
describe('TikTok tracking setup', () => {
  it('preserves merchant UTMs, encoding, macros and fragments and sends only the tracking patch', async () => {
    const h = providerHarness();
    const plan = await h.provider.read(context, ad);
    expect(plan.nextUrls[0]).toContain('utm_content=merchant%20value&custom=__CID__');
    expect(plan.nextUrls[0]).toContain('metrico_tiktok_ad_id=44');
    expect(plan.nextUrls[0]).toContain('metrico_tiktok_creative_id=__CID__#details');
    expect(await h.provider.install(context, ad, plan.hash)).toBe('UPDATED');
    const update = h.calls.find((c) => c.endpoint === 'ad/update')!;
    expect(update.options).toMatchObject({
      retry: false,
      method: 'POST',
      body: {
        advertiser_id: '11',
        adgroup_id: '33',
        patch_update: true,
        creatives: [{ ad_id: '44', landing_page_url: plan.nextUrls[0] }],
      },
    });
    expect(Object.keys((update.options.body as { creatives: object[] }).creatives[0]!)).toEqual([
      'ad_id',
      'landing_page_url',
    ]);
    expect(await h.provider.install(context, ad, plan.hash)).toBe('SKIPPED');
  });
  it('refuses a destination edited after preview without issuing a mutation', async () => {
    const h = providerHarness();
    const plan = await h.provider.read(context, ad);
    h.setLive({ ...raw, landing_page_url: 'https://shop.example/changed' });
    await expect(h.provider.install(context, ad, plan.hash)).rejects.toMatchObject({
      code: 'TIKTOK_TRACKING_SNAPSHOT_STALE',
    });
    expect(h.calls.some((c) => c.options.method === 'POST')).toBe(false);
  });
  it('requires a signed preview, binds store and exact selected ads, and does not write during preview', async () => {
    const h = serviceHarness();
    const preview = await h.service.apply('store-a', { adIds: ['44'], dryRun: true });
    expect(preview.previewToken).toBeTruthy();
    expect(h.calls.some((c) => c.options.method === 'POST')).toBe(false);
    await expect(
      h.service.apply('store-b', {
        adIds: ['44'],
        dryRun: false,
        previewToken: preview.previewToken!,
      }),
    ).rejects.toMatchObject({ code: 'TIKTOK_TRACKING_PREVIEW_REQUIRED' });
    await expect(
      h.service.apply('store-a', { adIds: ['999'], dryRun: true }),
    ).rejects.toMatchObject({ code: 'TIKTOK_AD_NOT_ACCESSIBLE' });
    await expect(
      h.service.apply('store-a', {
        adIds: ['44'],
        dryRun: false,
        previewToken: preview.previewToken! + 'x',
      }),
    ).rejects.toMatchObject({ code: 'TIKTOK_TRACKING_PREVIEW_REQUIRED' });
    expect(
      (
        await h.service.apply('store-a', {
          adIds: ['44'],
          dryRun: false,
          previewToken: preview.previewToken!,
        })
      ).results[0]!.status,
    ).toBe('UPDATED');
    expect(h.findAds).toHaveBeenCalledWith('store-a', ['11']);
  });
  it('expires previews and rejects previews after connection change', async () => {
    const h = serviceHarness();
    const preview = await h.service.apply('store-a', { adIds: ['44'], dryRun: true });
    h.setContext({ ...context, connectionId: 'other' });
    await expect(
      h.service.apply('store-a', {
        adIds: ['44'],
        dryRun: false,
        previewToken: preview.previewToken!,
      }),
    ).rejects.toMatchObject({ code: 'TIKTOK_TRACKING_PREVIEW_REQUIRED' });
    h.setContext(context);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    await expect(
      h.service.apply('store-a', {
        adIds: ['44'],
        dryRun: false,
        previewToken: preview.previewToken!,
      }),
    ).rejects.toMatchObject({ code: 'TIKTOK_TRACKING_PREVIEW_REQUIRED' });
    now.mockRestore();
  });
  it('does not report verified installation when TikTok returns success without saving', async () => {
    const request = vi.fn(async (_c, endpoint: string) =>
      endpoint === 'ad/get' ? { list: [raw] } : {},
    );
    const provider = new TikTokTrackingProvider({ request } as unknown as TikTokApiService);
    const plan = await provider.read(context, ad);
    await expect(provider.install(context, ad, plan.hash)).rejects.toMatchObject({
      code: 'TIKTOK_TRACKING_VERIFY_REQUIRED',
    });
  });
  it('supports Smart+ destination lists without sending creative or configuration replacements', async () => {
    const smartRaw = {
      advertiser_id: '11',
      smart_plus_ad_id: '44',
      campaign_id: '22',
      adgroup_id: '33',
      landing_page_url_list: [
        { landing_page_url: 'https://shop.example/a?utm_source=tiktok' },
        { landing_page_url: 'https://shop.example/b' },
      ],
      ad_configuration: { utm_params: [{ key: 'utm_medium', value: 'paid_social' }] },
    };
    const smartAd = { ...ad, rawJson: smartRaw } as TikTokTrackingAd;
    let live = smartRaw;
    const request = vi.fn(
      async (
        _c,
        endpoint: string,
        options: { body?: { landing_page_url_list: typeof smartRaw.landing_page_url_list } },
      ) => {
        if (endpoint === 'smart_plus/ad/get') return { list: [live] };
        live = { ...live, landing_page_url_list: options.body!.landing_page_url_list };
        return {};
      },
    );
    const provider = new TikTokTrackingProvider({ request } as unknown as TikTokApiService);
    const plan = await provider.read(context, smartAd);
    expect(await provider.install(context, smartAd, plan.hash)).toBe('UPDATED');
    expect(
      Object.keys(request.mock.calls.find((c) => c[1] === 'smart_plus/ad/update')![2]!.body!),
    ).toEqual(['advertiser_id', 'smart_plus_ad_id', 'landing_page_url_list']);
  });
  it('manual templates distinguish standard creative ID from Smart+ ad ID', () => {
    const config = serviceHarness().service.manualConfiguration();
    expect(config.urlParameters).toContain('metrico_tiktok_creative_id=__CID__');
    expect(config.urlParameters).not.toContain('metrico_tiktok_ad_id');
    expect(config.smartPlusUrlParameters).toContain('metrico_tiktok_ad_id=__ADID_V2__');
  });
  it.each([
    { ...raw, creative_material_mode: 'DYNAMIC' },
    { ...raw, landing_page_url: 'https://shop.example/?signature=abc' },
    { ...raw, campaign_id: 'different' },
  ])('rejects unsafe ad shapes', (fixture) => {
    expect(() => trackingPlan(ad, fixture)).toThrow();
  });
  it('requires explicit IDs and a preview for installation, with at most 50 ads', () => {
    expect(tiktokTrackingApplySchema.safeParse({ adIds: ['44'], dryRun: false }).success).toBe(
      false,
    );
    expect(tiktokTrackingApplySchema.safeParse({ adIds: Array(51).fill('44') }).success).toBe(
      false,
    );
  });
});

import { extractStorefrontAttribution } from '../../../src/modules/pixel/pixel.privacy.js';
import { summarizeRouting } from '../../../src/modules/conversion-delivery/source-routing.js';
it('captures numeric TikTok identifiers without UTM and keeps creative separate from ad', () => {
  const attribution = extractStorefrontAttribution(
    'https://shop.example/?metrico_tiktok_campaign_id=22&metrico_tiktok_adgroup_id=33&metrico_tiktok_ad_id=44&metrico_tiktok_creative_id=55',
  );
  expect(attribution).toEqual({
    tiktokCampaignExternalId: '22',
    tiktokAdGroupExternalId: '33',
    tiktokAdExternalId: '44',
    tiktokCreativeExternalId: '55',
  });
  const now = new Date('2026-10-14T08:00:00Z');
  const result = summarizeRouting([{ ...attribution, eventAt: now }], now, new Date('2026-10-01'));
  expect(result.eligibleProviders).toEqual(['TIKTOK']);
  expect(result.lastPaidTouch?.campaign).toBe('22');
  expect(result.lastPaidTouch?.ad).toBe('44');
  const creativeOnly = summarizeRouting(
    [{ tiktokCreativeExternalId: '55', eventAt: now }],
    now,
    new Date('2026-10-01'),
  );
  expect(creativeOnly.lastPaidTouch?.ad).toBeNull();
  expect(
    extractStorefrontAttribution(
      'https://shop.example/?metrico_tiktok_campaign_id=__CAMPAIGN_ID__',
    ),
  ).toEqual({});
});
it('withholds conflicting TikTok link IDs and Meta or organic evidence', () => {
  const now = new Date('2026-10-14T08:00:00Z');
  for (const evidence of [
    { tiktokCampaignExternalId: '22', metaAdExternalId: '44' },
    { tiktokCampaignExternalId: '22', utmSource: 'meta', utmMedium: 'paid_social' },
    { tiktokCampaignExternalId: '22', utmSource: 'tiktok', utmMedium: 'organic' },
  ]) {
    expect(
      summarizeRouting([{ ...evidence, eventAt: now }], now, new Date('2026-10-01'))
        .eligibleProviders,
    ).toEqual([]);
  }
});
