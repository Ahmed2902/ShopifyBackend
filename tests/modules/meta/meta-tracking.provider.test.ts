import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaApiContext } from '../../../src/modules/meta/meta.types.js';
import { MetaTrackingProvider } from '../../../src/modules/meta/tracking/meta-tracking.provider.js';
import type { MetaTrackingAd } from '../../../src/modules/meta/tracking/meta-tracking.repository.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  accessToken: 'access-token',
  apiVersion: 'v25.0',
  scopes: ['ads_read', 'ads_management'],
  metaBusinessId: null,
  selectedAdAccountIds: ['act_9009'],
  selectedCatalogIds: [],
} as MetaApiContext;

const ad = {
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
} as MetaTrackingAd;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetaTrackingProvider', () => {
  it('rejects automatic tracking when the live ad creative changed after the last sync', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '3003', creative: { id: '9999' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new MetaTrackingProvider().cloneCreativeAndAssign(context, ad, 'stride_meta_ad_id={{ad.id}}'),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'META_TRACKING_SNAPSHOT_STALE',
      details: {
        metaAdId: '3003',
        syncedCreativeId: '4004',
        liveCreativeId: '9999',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'GET' }));
  });

  it('mutates only after the live creative still matches the synced snapshot', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '3003', creative: { id: '4004' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '5005' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '3003' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new MetaTrackingProvider().cloneCreativeAndAssign(context, ad, 'stride_meta_ad_id={{ad.id}}'),
    ).resolves.toEqual({ newCreativeId: '5005' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
  });

  it('preserves degrees-of-freedom enhancements when cloning a post-based creative', async () => {
    const enhancedAd = {
      ...ad,
      creative: {
        ...ad.creative!,
        degreesOfFreedomSpec: {
          creative_features_spec: {
            standard_enhancements: { enroll_status: 'OPT_IN' },
          },
        },
      },
    } as MetaTrackingAd;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '3003', creative: { id: '4004' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '5005' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '3003' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new MetaTrackingProvider().cloneCreativeAndAssign(
        context,
        enhancedAd,
        'stride_meta_ad_id={{ad.id}}',
      ),
    ).resolves.toEqual({ newCreativeId: '5005' });

    const createRequest = fetchMock.mock.calls[1]?.[1];
    expect(createRequest).toEqual(expect.objectContaining({ method: 'POST' }));
    const body = createRequest?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get('object_story_id')).toBe('123_456');
    expect(params.get('degrees_of_freedom_spec')).toBe(
      JSON.stringify(enhancedAd.creative?.degreesOfFreedomSpec),
    );
  });
});
