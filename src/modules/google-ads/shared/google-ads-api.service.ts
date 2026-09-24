import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import type { GoogleAdsObject } from '../google-ads.types.js';
import { normalizeCustomerId } from '../google-ads.utils.js';

const MAX_SEARCH_PAGES = 100;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type GoogleApiErrorBody = {
  error?: {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    details?: Array<{ errors?: Array<{ errorCode?: Record<string, unknown>; message?: unknown }> }>;
  };
};

function errorStatus(body: unknown) {
  if (!body || typeof body !== 'object') return null;
  const status = (body as GoogleApiErrorBody).error?.status;
  return typeof status === 'string' ? status : null;
}

function googleAdsErrorNames(body: unknown) {
  if (!body || typeof body !== 'object') return [];
  const details = (body as GoogleApiErrorBody).error?.details ?? [];
  const names = new Set<string>();
  for (const detail of details) {
    for (const error of detail.errors ?? []) {
      for (const [category, value] of Object.entries(error.errorCode ?? {})) {
        if (typeof value === 'string') names.add(`${category}.${value}`);
      }
    }
  }
  return [...names];
}

function safeProviderMessage(body: unknown, fallback: string) {
  const status = errorStatus(body);
  return status ? `${fallback} (${status})` : fallback;
}

function classifyProviderError(httpStatus: number, body: unknown) {
  const names = googleAdsErrorNames(body);
  if (httpStatus === 401) return { status: 401, code: 'GOOGLE_ADS_REAUTH_REQUIRED' } as const;
  if (httpStatus === 429) return { status: 429, code: 'GOOGLE_ADS_RATE_LIMITED' } as const;
  if (names.some((name) => name.includes('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'))) {
    return { status: 403, code: 'GOOGLE_ADS_API_ACCESS_NOT_APPROVED' } as const;
  }
  if (
    names.some(
      (name) =>
        name.includes('USER_PERMISSION_DENIED') ||
        name.includes('CUSTOMER_NOT_ENABLED') ||
        name.includes('CUSTOMER_NOT_FOUND'),
    )
  ) {
    return { status: 403, code: 'GOOGLE_ADS_CUSTOMER_NOT_ACCESSIBLE' } as const;
  }
  if (httpStatus === 403) return { status: 403, code: 'GOOGLE_ADS_API_AUTHORIZATION_FAILED' } as const;
  return { status: 502, code: 'GOOGLE_ADS_REQUEST_FAILED' } as const;
}

function developerToken() {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    throw new AppError(
      'Google Ads API developer token is not configured',
      503,
      'GOOGLE_ADS_NOT_CONFIGURED',
    );
  }
  return env.GOOGLE_ADS_DEVELOPER_TOKEN;
}

export class GoogleAdsApiService {
  private base(apiVersion: string) {
    return `https://googleads.googleapis.com/${apiVersion}`;
  }

  private async request<T>(input: {
    accessToken: string;
    apiVersion: string;
    path: string;
    method?: 'GET' | 'POST';
    loginCustomerId?: string | null;
    body?: unknown;
  }): Promise<T> {
    const token = developerToken();
    let lastStatus = 502;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${this.base(input.apiVersion)}${input.path}`, {
        method: input.method ?? 'GET',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'content-type': 'application/json',
          'developer-token': token,
          ...(input.loginCustomerId
            ? { 'login-customer-id': normalizeCustomerId(input.loginCustomerId) }
            : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      const body = (await response.json().catch(() => null)) as T | null;
      if (response.ok && body !== null) return body;
      lastStatus = response.status;

      if (!RETRYABLE_STATUS.has(response.status) || attempt === 4) {
        const classified = classifyProviderError(response.status, body);
        throw new AppError(
          safeProviderMessage(body, 'Google Ads request failed'),
          classified.status,
          classified.code,
          { httpStatus: response.status, providerErrors: googleAdsErrorNames(body) },
        );
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(500 * 2 ** attempt, 8_000);
      await sleep(delay);
    }
    throw new AppError('Google Ads request failed', lastStatus, 'GOOGLE_ADS_REQUEST_FAILED');
  }

  async listAccessibleCustomers(accessToken: string, apiVersion: string) {
    const result = await this.request<{ resourceNames?: string[] }>({
      accessToken,
      apiVersion,
      path: '/customers:listAccessibleCustomers',
    });
    return (result.resourceNames ?? []).map((name) =>
      normalizeCustomerId(name.split('/').pop() ?? ''),
    );
  }

  async search(input: {
    accessToken: string;
    apiVersion: string;
    customerId: string;
    loginCustomerId?: string | null;
    query: string;
  }): Promise<GoogleAdsObject[]> {
    const customerId = normalizeCustomerId(input.customerId);
    const rows: GoogleAdsObject[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const result = await this.request<{ results?: GoogleAdsObject[]; nextPageToken?: string }>({
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        path: `/customers/${customerId}/googleAds:search`,
        method: 'POST',
        loginCustomerId: input.loginCustomerId,
        body: { query: input.query, ...(pageToken ? { pageToken } : {}) },
      });
      rows.push(...(result.results ?? []));
      pageToken = result.nextPageToken;
      if (!pageToken) return rows;
    }
    throw new AppError(
      'Google Ads search exceeded the bounded pagination limit',
      502,
      'GOOGLE_ADS_PAGINATION_LIMIT',
    );
  }

  async exchangeAuthorizationCode(code: string) {
    if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) {
      throw new AppError('Google Ads OAuth is not configured', 503, 'GOOGLE_ADS_NOT_CONFIGURED');
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_ADS_CLIENT_ID,
        client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri:
          env.GOOGLE_ADS_REDIRECT_URI ??
          new URL('/v1/integrations/google-ads/callback', `${env.APP_URL}/`).toString(),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
    };
    if (!response.ok || !body.access_token || !body.refresh_token) {
      throw new AppError('Google Ads OAuth exchange failed', 401, 'GOOGLE_ADS_OAUTH_FAILED');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in ?? 3600,
      scopes: body.scope?.split(/\s+/).filter(Boolean) ?? [],
    };
  }

  async refreshAccessToken(refreshToken: string) {
    if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) {
      throw new AppError('Google Ads OAuth is not configured', 503, 'GOOGLE_ADS_NOT_CONFIGURED');
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_ADS_CLIENT_ID,
        client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new AppError(
        'Google Ads refresh token requires reauthorization',
        401,
        'GOOGLE_ADS_REAUTH_REQUIRED',
      );
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
  }

  async revokeToken(token: string) {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) {
      throw new AppError('Google OAuth token revocation failed', 502, 'GOOGLE_ADS_REVOCATION_FAILED');
    }
  }
}
