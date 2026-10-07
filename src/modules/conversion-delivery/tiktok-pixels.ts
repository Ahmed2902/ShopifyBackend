import { AppError } from '../../errors/app-error.js';
import type { TikTokApiService } from '../tiktok/shared/tiktok-api.service.js';
import type { TikTokApiContext } from '../tiktok/tiktok.types.js';

export async function listTikTokPixels(
  api: TikTokApiService,
  context: TikTokApiContext,
  advertiserId: string,
) {
  if (!context.selectedAdvertiserIds.includes(advertiserId))
    throw new AppError(
      'TikTok advertiser is not selected for this store',
      403,
      'TIKTOK_ADVERTISER_NOT_SELECTED',
    );
  const pixels: Array<{ code: string; name: string }> = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api.request<{
      pixels?: Array<{ pixel_code?: string; code?: string; pixel_name?: string; name?: string }>;
      page_info?: { total_page?: number };
    }>(context, 'pixel/list', {
      query: { advertiser_id: advertiserId, page, page_size: 100 },
    });
    const rows = data.pixels;
    if (!Array.isArray(rows))
      throw new AppError(
        'TikTok returned an invalid tracking destination list',
        502,
        'TIKTOK_PIXEL_LIST_INVALID',
      );
    for (const row of rows) {
      const code = row.pixel_code ?? row.code;
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) continue;
      const name = row.pixel_name ?? row.name;
      pixels.push({
        code,
        name: typeof name === 'string' && name.trim() ? name.trim() : 'TikTok store tracking',
      });
    }
    const total = data.page_info?.total_page;
    if (typeof total === 'number' && total <= page) return pixels;
    if (rows.length < 100 && total === undefined) return pixels;
  }
  throw new AppError(
    'TikTok tracking destinations exceed the supported discovery limit',
    502,
    'TIKTOK_PIXEL_LIST_LIMIT',
  );
}
