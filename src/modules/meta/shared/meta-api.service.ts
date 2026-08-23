import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import type { MetaRepository } from '../meta.repository.js';
import {
  metaAdAccountSchema,
  metaBusinessSchema,
  metaGraphErrorSchema,
  metaTokenDebugSchema,
  metaTokenResponseSchema,
  metaUserSchema,
} from '../meta.schema.js';
import type {
  MetaAdAccountAsset,
  MetaApiContext,
  MetaBusinessAsset,
  MetaTokenExchange,
  MetaTokenInspection,
} from '../meta.types.js';
import { computeMetaAppSecretProof, parseMetaMinorAmount } from '../meta.utils.js';

const MAX_ATTEMPTS = 3;
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 613]);
const AD_ACCOUNT_FIELDS = [
  'id',
  'account_id',
  'name',
  'account_status',
  'currency',
  'timezone_name',
  'timezone_id',
  'timezone_offset_hours_utc',
  'amount_spent',
  'balance',
  'spend_cap',
  'business',
].join(',');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAdAccount(item: unknown): MetaAdAccountAsset | null {
  const parsed = metaAdAccountSchema.safeParse(item);
  if (!parsed.success) return null;
  const account = parsed.data;
  return {
    id: account.id,
    accountId: account.account_id,
    name: account.name,
    accountStatus: account.account_status ?? null,
    currency: account.currency,
    timezoneName: account.timezone_name ?? null,
    timezoneId: account.timezone_id ?? null,
    timezoneOffsetHoursUtc: account.timezone_offset_hours_utc ?? null,
    amountSpentMinor: parseMetaMinorAmount(account.amount_spent),
    balanceMinor: parseMetaMinorAmount(account.balance),
    spendCapMinor: parseMetaMinorAmount(account.spend_cap),
    business: account.business ?? null,
    raw: item,
  };
}

export class MetaApiService {
  constructor(private readonly repository: MetaRepository) {}

  async exchangeAuthorizationCode(code: string): Promise<MetaTokenExchange> {
    const shortLived = await this.requestToken({
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      redirect_uri: env.META_REDIRECT_URI,
      code,
    });

    return this.requestToken({
      grant_type: 'fb_exchange_token',
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      fb_exchange_token: shortLived.accessToken,
    });
  }

  async inspectAccessToken(accessToken: string): Promise<MetaTokenInspection> {
    const url = this.graphUrl('/debug_token');
    url.searchParams.set('input_token', accessToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.META_APP_ID}|${env.META_APP_SECRET}` },
    });
    const body = await this.parseResponseBody(response);
    if (!response.ok) throw this.toProviderError(body, response.status);

    const parsed = metaTokenDebugSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        'Meta token debugger returned an unexpected response',
        502,
        'META_BAD_RESPONSE',
      );
    }

    const data = parsed.data.data;
    return {
      appId: data.app_id,
      userId: data.user_id,
      isValid: data.is_valid,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
      scopes: data.scopes,
    };
  }

  async fetchCurrentUser(context: MetaApiContext): Promise<{ id: string }> {
    const payload = await this.requestGraph(context, '/me', { fields: 'id' });
    const parsed = metaUserSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('Meta user response was invalid', 502, 'META_BAD_RESPONSE');
    }
    return parsed.data;
  }

  listBusinesses(context: MetaApiContext): Promise<MetaBusinessAsset[]> {
    return this.collectGraphPages(context, '/me/businesses', { fields: 'id,name', limit: '100' }, (item) => {
      const parsed = metaBusinessSchema.safeParse(item);
      return parsed.success ? parsed.data : null;
    });
  }

  listAdAccounts(context: MetaApiContext): Promise<MetaAdAccountAsset[]> {
    return this.collectGraphPages(
      context,
      '/me/adaccounts',
      { fields: AD_ACCOUNT_FIELDS, limit: '100' },
      parseAdAccount,
    );
  }

  async getAdAccount(context: MetaApiContext, adAccountId: string): Promise<MetaAdAccountAsset> {
    const payload = await this.requestGraph(context, `/${adAccountId}`, {
      fields: AD_ACCOUNT_FIELDS,
    });
    const account = parseAdAccount(payload);
    if (!account || account.id !== adAccountId) {
      throw new AppError('Meta ad account response was invalid', 502, 'META_BAD_RESPONSE');
    }
    return account;
  }

  async requestGraph(
    context: MetaApiContext,
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    let lastNetworkError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const url = this.graphUrl(path, context.apiVersion);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      url.searchParams.set('appsecret_proof', computeMetaAppSecretProof(context.accessToken));

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${context.accessToken}` },
        });
      } catch (error) {
        lastNetworkError = error;
        if (attempt === MAX_ATTEMPTS) {
          throw new AppError('Meta API network request failed', 502, 'META_REQUEST_FAILED');
        }
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      const body = await this.parseResponseBody(response);
      const graph = metaGraphErrorSchema.safeParse(body);
      if (response.ok && !graph.success) return body;

      const code = graph.success ? graph.data.error.code : undefined;
      if (code === 190) {
        await this.repository.markConnectionReauthRequired(context.connectionId).catch(() => undefined);
        throw new AppError(
          'Meta access token requires reauthorization',
          401,
          'META_REAUTH_REQUIRED',
        );
      }

      const providerError = this.toProviderError(body, response.status);
      const transient =
        response.status === 429 ||
        response.status >= 500 ||
        (graph.success &&
          (graph.data.error.is_transient === true ||
            (code !== undefined && TRANSIENT_META_CODES.has(code))));
      if (!transient || attempt === MAX_ATTEMPTS) throw providerError;

      await sleep(250 * 2 ** (attempt - 1));
    }

    throw lastNetworkError ?? new AppError('Meta API request failed', 502, 'META_REQUEST_FAILED');
  }

  async collectGraphPages<T>(
    context: MetaApiContext,
    path: string,
    baseParams: Record<string, string>,
    parseItem: (item: unknown) => T | null,
  ): Promise<T[]> {
    const items: T[] = [];
    let after: string | null = null;
    const seenCursors = new Set<string>();

    while (true) {
      const payload = await this.requestGraph(context, path, {
        ...baseParams,
        ...(after ? { after } : {}),
      });
      const record = asRecord(payload);
      const data = record?.data;
      if (!Array.isArray(data)) {
        throw new AppError('Meta collection response was invalid', 502, 'META_BAD_RESPONSE');
      }

      for (const item of data) {
        const parsed = parseItem(item);
        if (parsed !== null) items.push(parsed);
      }

      const paging = asRecord(record?.paging);
      const cursors = asRecord(paging?.cursors);
      const next = typeof cursors?.after === 'string' ? cursors.after : null;
      if (!paging?.next || !next) return items;
      if (seenCursors.has(next)) {
        throw new AppError('Meta pagination returned a repeated cursor', 502, 'META_BAD_PAGINATION');
      }
      seenCursors.add(next);
      after = next;
    }
  }

  private async requestToken(params: Record<string, string>): Promise<MetaTokenExchange> {
    const url = this.graphUrl('/oauth/access_token');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await fetch(url);
    const body = await this.parseResponseBody(response);
    if (!response.ok) throw this.toProviderError(body, response.status);

    const parsed = metaTokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('Meta token exchange returned an unexpected response', 502, 'META_BAD_RESPONSE');
    }
    return {
      accessToken: parsed.data.access_token,
      expiresInSeconds: parsed.data.expires_in ?? null,
    };
  }

  private graphUrl(path: string, apiVersion = env.META_API_VERSION): URL {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return new URL(`https://graph.facebook.com/${apiVersion}${normalizedPath}`);
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError('Meta returned a non-JSON response', 502, 'META_BAD_RESPONSE');
    }
  }

  private toProviderError(body: unknown, httpStatus: number): AppError {
    const parsed = metaGraphErrorSchema.safeParse(body);
    if (!parsed.success) {
      return new AppError(
        `Meta API request failed with HTTP ${httpStatus}`,
        httpStatus >= 500 ? 502 : 400,
        'META_REQUEST_FAILED',
      );
    }

    const error = parsed.data.error;
    const permissionDenied = error.code === 200 || error.code === 10;
    return new AppError(
      `Meta API error: ${error.message}`,
      permissionDenied ? 403 : httpStatus >= 500 ? 502 : 400,
      permissionDenied ? 'META_PERMISSION_DENIED' : 'META_REQUEST_FAILED',
    );
  }
}
