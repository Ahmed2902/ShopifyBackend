import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { measureRequestPerformanceSpan } from '../../../observability/request-performance.js';
import type {
  TikTokApiContext,
  TikTokApiEnvelope,
  TikTokAuthorizedAdvertiser,
  TikTokBusinessCenter,
  TikTokObject,
  TikTokPagedData,
} from '../tiktok.types.js';
import { asRecord, asString, asStringArray } from '../tiktok.utils.js';

const MAX_RETRIES = 3;
const MAX_PAGES = 250;

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  accessToken?: string;
  retry?: boolean;
}

const SMART_PLUS_ENDPOINTS: Record<string, string> = {
  'campaign/get': 'smart_plus/campaign/get',
  'adgroup/get': 'smart_plus/adgroup/get',
  'ad/get': 'smart_plus/ad/get',
};

function serializeQueryValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function webhookCallbackUrl(): string {
  return new URL(env.TIKTOK_WEBHOOK_URL).toString();
}

function nestedStringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const found = asString(record[key]);
    return found ? [found] : [];
  });
}

function normalizeSmartPlusRecord(input: TikTokObject): TikTokObject {
  const record = { ...input };
  if (record.campaign_id == null && record.smart_plus_campaign_id != null) {
    record.campaign_id = record.smart_plus_campaign_id;
  }
  if (record.adgroup_id == null && record.smart_plus_adgroup_id != null) {
    record.adgroup_id = record.smart_plus_adgroup_id;
  }
  if (record.ad_id == null && record.smart_plus_ad_id != null) {
    record.ad_id = record.smart_plus_ad_id;
  }

  const dimensions = asRecord(record.dimensions);
  if (Object.keys(dimensions).length > 0 && dimensions.ad_id == null && dimensions.ad_id_v2 != null) {
    record.dimensions = { ...dimensions, ad_id: dimensions.ad_id_v2 };
  }

  const creativeList = Array.isArray(record.creative_list)
    ? record.creative_list.map(asRecord)
    : [];
  const firstCreative = creativeList[0] ?? {};
  const creativeInfo = asRecord(firstCreative.creative_info ?? firstCreative);

  if (record.video_info == null && creativeInfo.video_info != null) {
    record.video_info = creativeInfo.video_info;
  }
  if (record.image_info == null && creativeInfo.image_info != null) {
    record.image_info = creativeInfo.image_info;
  }
  if (record.identity_id == null && creativeInfo.identity_id != null) {
    record.identity_id = creativeInfo.identity_id;
  }
  if (record.identity_type == null && creativeInfo.identity_type != null) {
    record.identity_type = creativeInfo.identity_type;
  }
  if (record.ad_format == null && creativeInfo.ad_format != null) {
    record.ad_format = creativeInfo.ad_format;
  }

  const landingUrls = nestedStringList(record.landing_page_url_list, 'landing_page_url');
  if (record.landing_page_url == null && landingUrls[0]) record.landing_page_url = landingUrls[0];
  if (landingUrls.length > 0) record.landing_page_url_list = landingUrls;

  const adTexts = nestedStringList(record.ad_text_list, 'ad_text');
  if (record.ad_text == null && adTexts[0]) record.ad_text = adTexts[0];
  if (adTexts.length > 0) record.ad_text_list = adTexts;

  return record;
}

function objectKey(record: TikTokObject): string {
  return (
    asString(record.ad_id) ??
    asString(record.smart_plus_ad_id) ??
    asString(record.adgroup_id) ??
    asString(record.smart_plus_adgroup_id) ??
    asString(record.campaign_id) ??
    asString(record.smart_plus_campaign_id) ??
    JSON.stringify(record)
  );
}

export class TikTokApiService {
  private buildUrl(endpoint: string, query?: Record<string, unknown>): URL {
    const normalized = endpoint.replace(/^\/+|\/+$/g, '');
    const url = new URL(
      `https://business-api.tiktok.com/open_api/${env.TIKTOK_API_VERSION}/${normalized}/`,
    );
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      const normalizedValue =
        endpoint === 'report/integrated/get' && key === 'dimensions' && Array.isArray(value)
          ? value.map((dimension) => (dimension === 'ad_id' ? 'ad_id_v2' : dimension))
          : value;
      url.searchParams.set(key, serializeQueryValue(normalizedValue));
    }
    return url;
  }

  private async execute<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(endpoint, method === 'GET' ? options.query : undefined);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.accessToken) headers['Access-Token'] = options.accessToken;
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const retry = options.retry ?? true;
    let lastError: unknown;
    for (let attempt = 0; attempt < (retry ? MAX_RETRIES : 1); attempt += 1) {
      try {
        const response = await measureRequestPerformanceSpan('tiktok.business_api.http', () =>
          fetch(url, {
            method,
            headers,
            body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
            signal: AbortSignal.timeout(30_000),
          }),
        );

        const payload = (await response.json().catch(() => null)) as TikTokApiEnvelope<T> | null;
        if (!payload || typeof payload.code !== 'number') {
          if (response.status === 429 || response.status >= 500) {
            throw new AppError(
              'TikTok API returned a transient invalid response',
              502,
              'TIKTOK_BAD_RESPONSE',
            );
          }
          throw new AppError('TikTok API returned an invalid response', 502, 'TIKTOK_BAD_RESPONSE');
        }

        if (response.ok && payload.code === 0) return payload.data;

        const status =
          response.status === 401 || response.status === 403
            ? 401
            : response.status === 429
              ? 429
              : 502;
        const error = new AppError(
          payload.message || 'TikTok API request failed',
          status,
          status === 401
            ? 'TIKTOK_REAUTH_REQUIRED'
            : status === 429
              ? 'TIKTOK_RATE_LIMITED'
              : 'TIKTOK_API_ERROR',
          { providerCode: payload.code, requestId: payload.request_id, endpoint },
        );
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error instanceof AppError && error.statusCode < 500 && error.statusCode !== 429) {
          throw error;
        }
      }

      if (attempt < MAX_RETRIES - 1) {
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 150));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AppError('TikTok API request failed', 502, 'TIKTOK_API_ERROR');
  }

  request<T>(
    context: TikTokApiContext,
    endpoint: string,
    options: Omit<RequestOptions, 'accessToken'> = {},
  ) {
    return this.execute<T>(endpoint, { ...options, accessToken: context.accessToken });
  }

  async exchangeAuthorizationCode(authCode: string) {
    const data = await this.execute<Record<string, unknown>>('oauth2/access_token', {
      method: 'POST',
      body: {
        app_id: env.TIKTOK_APP_ID,
        secret: env.TIKTOK_APP_SECRET,
        auth_code: authCode,
      },
      retry: false,
    });
    const accessToken = asString(data.access_token);
    if (!accessToken) {
      throw new AppError(
        'TikTok did not return an access token',
        502,
        'TIKTOK_BAD_TOKEN_RESPONSE',
      );
    }
    return {
      accessToken,
      advertiserIds: asStringArray(data.advertiser_ids),
      scopes: asStringArray(data.scope ?? data.scopes),
    };
  }

  async listAuthorizedAdvertisers(accessToken: string): Promise<TikTokAuthorizedAdvertiser[]> {
    const data = await this.execute<Record<string, unknown>>('oauth2/advertiser/get', {
      query: { app_id: env.TIKTOK_APP_ID, secret: env.TIKTOK_APP_SECRET },
      accessToken,
    });
    const list = Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.advertisers)
        ? data.advertisers
        : [];
    return list.flatMap((item) => {
      const record = asRecord(item);
      const advertiserId = asString(record.advertiser_id);
      return advertiserId
        ? [
            {
              advertiser_id: advertiserId,
              advertiser_name: asString(record.advertiser_name) ?? undefined,
            },
          ]
        : [];
    });
  }

  async listBusinessCenters(context: TikTokApiContext): Promise<TikTokBusinessCenter[]> {
    const data = await this.request<Record<string, unknown>>(context, 'bc/get', {
      query: { page: 1, page_size: 100 },
    });
    const list = Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.bc_list)
        ? data.bc_list
        : [];
    return list.flatMap((item) => {
      const record = asRecord(item);
      const bcId = asString(record.bc_id) ?? asString(record.id);
      return bcId ? [{ ...record, bc_id: bcId } as TikTokBusinessCenter] : [];
    });
  }

  async getAdvertiserInfo(
    context: TikTokApiContext,
    advertiserIds: string[],
  ): Promise<TikTokObject[]> {
    if (advertiserIds.length === 0) return [];
    const data = await this.request<Record<string, unknown>>(context, 'advertiser/info', {
      query: {
        advertiser_ids: advertiserIds,
        fields: [
          'advertiser_id',
          'name',
          'status',
          'currency',
          'timezone',
          'country',
          'industry',
          'company',
          'balance',
        ],
      },
    });
    return (Array.isArray(data.list) ? data.list : []).map(asRecord);
  }

  async subscribeReportDataChanges(context: TikTokApiContext, advertiserIds: string[]) {
    if (advertiserIds.length === 0) return null;
    return this.execute<Record<string, unknown>>('subscription/subscribe', {
      method: 'POST',
      body: {
        app_id: env.TIKTOK_APP_ID,
        secret: env.TIKTOK_APP_SECRET,
        subscribe_entity: 'REPORT_DATA_CHANGE',
        callback_url: webhookCallbackUrl(),
        subscription_detail: {
          access_token: context.accessToken,
          advertiser_ids: advertiserIds,
          notify_frequency: '5_MINUTE',
        },
      },
    });
  }

  listSubscriptions(subscribeEntity?: string) {
    return this.execute<Record<string, unknown>>('subscription/get', {
      query: {
        app_id: env.TIKTOK_APP_ID,
        secret: env.TIKTOK_APP_SECRET,
        subscribe_entity: subscribeEntity,
        page: 1,
        page_size: 1000,
      },
    });
  }

  async ensureReportDataChangeSubscription(
    context: TikTokApiContext,
    advertiserIds: string[],
  ) {
    const wanted = [...new Set(advertiserIds)].sort();
    if (wanted.length === 0) return { created: false, subscription: null };

    const existing = await this.listSubscriptions('REPORT_DATA_CHANGE').catch(() => null);
    const list = existing && Array.isArray(existing.list) ? existing.list : [];
    for (const raw of list) {
      const subscription = asRecord(raw);
      const detail = asRecord(subscription.subscription_detail);
      const ids = asStringArray(detail.advertiser_ids).sort();
      const callback = asString(subscription.callback_url);
      if (
        callback === webhookCallbackUrl() &&
        ids.length === wanted.length &&
        ids.every((id, index) => id === wanted[index])
      ) {
        return { created: false, subscription };
      }
    }

    return {
      created: true,
      subscription: await this.subscribeReportDataChanges(context, wanted),
    };
  }

  private async paginateEndpoint(
    context: TikTokApiContext,
    endpoint: string,
    query: Record<string, unknown>,
    listKeys: string[],
    pageSize: number,
  ): Promise<TikTokObject[]> {
    const output: TikTokObject[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.request<TikTokPagedData<unknown> & Record<string, unknown>>(
        context,
        endpoint,
        { query: { ...query, page, page_size: pageSize } },
      );
      let rawList: unknown[] = [];
      for (const key of listKeys) {
        const candidate = data[key];
        if (Array.isArray(candidate)) {
          rawList = candidate;
          break;
        }
      }
      output.push(...rawList.map(asRecord).map(normalizeSmartPlusRecord));

      const pageInfo = asRecord(data.page_info);
      const totalPage = Number(pageInfo.total_page ?? 0);
      if (totalPage > 0) {
        if (page >= totalPage) break;
      } else if (rawList.length < pageSize) {
        break;
      }
    }
    return output;
  }

  async paginate(
    context: TikTokApiContext,
    endpoint: string,
    query: Record<string, unknown>,
    listKeys: string[] = ['list'],
    pageSize = 100,
  ): Promise<TikTokObject[]> {
    const regular = await this.paginateEndpoint(context, endpoint, query, listKeys, pageSize);
    const smartEndpoint = SMART_PLUS_ENDPOINTS[endpoint];
    if (!smartEndpoint) return regular;

    const smart = await this.paginateEndpoint(context, smartEndpoint, query, listKeys, pageSize);

    const merged = new Map<string, TikTokObject>();
    for (const record of [...regular, ...smart]) merged.set(objectKey(record), record);
    return [...merged.values()];
  }
}
