import { afterEach, describe, expect, it, vi } from 'vitest';
import { TikTokApiService } from '../../../src/modules/tiktok/shared/tiktok-api.service.js';
import type { TikTokApiContext } from '../../../src/modules/tiktok/tiktok.types.js';

const context: TikTokApiContext = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  status: 'ACTIVE',
  accessToken: 'access-token',
  apiVersion: 'v1.3',
  scopes: [],
  businessCenterId: null,
  selectedAdvertiserIds: ['123'],
  selectedCatalogIds: [],
};

function response(data: unknown) {
  return new Response(JSON.stringify({ code: 0, message: 'OK', request_id: 'req', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('TikTokApiService', () => {
  it('merges regular and Upgraded Smart+ hierarchy records', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/smart_plus/campaign/get/')) {
        return response({
          list: [
            {
              smart_plus_campaign_id: 'smart-campaign',
              campaign_name: 'Smart Campaign',
            },
          ],
          page_info: { total_page: 1 },
        });
      }
      return response({
        list: [{ campaign_id: 'manual-campaign', campaign_name: 'Manual Campaign' }],
        page_info: { total_page: 1 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await new TikTokApiService().paginate(
      context,
      'campaign/get',
      { advertiser_id: '123' },
      ['list'],
    );

    expect(rows.map((row) => row.campaign_id)).toEqual([
      'manual-campaign',
      'smart-campaign',
    ]);
  });

  it('fails the logical hierarchy snapshot when Smart+ fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/smart_plus/campaign/get/')) {
          return new Response(
            JSON.stringify({ code: 50001, message: 'temporary provider failure', request_id: 'req' }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
        return response({
          list: [{ campaign_id: 'manual-campaign', campaign_name: 'Manual Campaign' }],
          page_info: { total_page: 1 },
        });
      }),
    );

    await expect(
      new TikTokApiService().paginate(
        context,
        'campaign/get',
        { advertiser_id: '123' },
        ['list'],
      ),
    ).rejects.toThrow('temporary provider failure');
  });

  it('uses ad_id_v2 for ad-level reports and aliases it back to ad_id internally', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return response({
          list: [
            {
              dimensions: { ad_id_v2: 'smart-ad', stat_time_day: '2026-08-24' },
              metrics: { spend: '10' },
            },
          ],
          page_info: { total_page: 1 },
        });
      }),
    );

    const rows = await new TikTokApiService().paginate(
      context,
      'report/integrated/get',
      {
        advertiser_id: '123',
        dimensions: ['ad_id', 'stat_time_day'],
        metrics: ['spend'],
      },
      ['list'],
    );

    expect(decodeURIComponent(requestedUrl)).toContain('ad_id_v2');
    expect((rows[0]!.dimensions as Record<string, unknown>).ad_id).toBe('smart-ad');
  });

  it('normalizes Smart+ nested creative text/url/video fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/smart_plus/ad/get/')) {
          return response({
            list: [
              {
                smart_plus_ad_id: 'smart-ad',
                creative_list: [
                  { creative_info: { video_info: { video_id: 'video-1' }, identity_id: 'identity-1' } },
                ],
                ad_text_list: [{ ad_text: 'Hook copy' }],
                landing_page_url_list: [{ landing_page_url: 'https://shop.example/products/a' }],
              },
            ],
            page_info: { total_page: 1 },
          });
        }
        return response({ list: [], page_info: { total_page: 1 } });
      }),
    );

    const rows = await new TikTokApiService().paginate(
      context,
      'ad/get',
      { advertiser_id: '123' },
      ['list'],
    );

    expect(rows[0]).toMatchObject({
      ad_id: 'smart-ad',
      ad_text: 'Hook copy',
      landing_page_url: 'https://shop.example/products/a',
      identity_id: 'identity-1',
      video_info: { video_id: 'video-1' },
    });
  });
});
