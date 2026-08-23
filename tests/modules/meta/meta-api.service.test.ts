import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';
import type { MetaApiContext } from '../../../src/modules/meta/meta.types.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const context: MetaApiContext = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  accessToken: 'meta-user-token',
  apiVersion: 'v26.0',
};

function buildService() {
  const repository = {
    markConnectionReauthRequired: vi.fn().mockResolvedValue(undefined),
  } as unknown as MetaRepository;
  return { repository, service: new MetaApiService(repository) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetaApiService', () => {
  it('exchanges the OAuth code for a long-lived token', async () => {
    const { service } = buildService();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'short-token', token_type: 'bearer', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.exchangeAuthorizationCode('oauth-code')).resolves.toEqual({
      accessToken: 'long-token',
      expiresInSeconds: 5_184_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = new URL(fetchMock.mock.calls[0]?.[0] as URL);
    expect(first.pathname).toBe('/v26.0/oauth/access_token');
    expect(first.searchParams.get('code')).toBe('oauth-code');
    expect(first.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/v1/integrations/meta/callback',
    );

    const second = new URL(fetchMock.mock.calls[1]?.[0] as URL);
    expect(second.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(second.searchParams.get('fb_exchange_token')).toBe('short-token');
  });

  it('adds bearer authentication and appsecret_proof to server Graph requests', async () => {
    const { service } = buildService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '123' }));
    vi.stubGlobal('fetch', fetchMock);

    await service.requestGraph(context, '/me', { fields: 'id' });

    const [rawUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe('/v26.0/me');
    expect(url.searchParams.get('fields')).toBe('id');
    expect(url.searchParams.get('appsecret_proof')).toMatch(/^[a-f0-9]{64}$/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer meta-user-token');
  });

  it('retries a transient Meta rate-limit error but not a successful retry', async () => {
    const { service } = buildService();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: 'Application request limit reached',
              type: 'OAuthException',
              code: 4,
              is_transient: true,
            },
          },
          429,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: '123' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.requestGraph(context, '/me')).resolves.toEqual({ id: '123' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks the connection for reauthorization on Meta error code 190', async () => {
    const { repository, service } = buildService();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: 'Invalid OAuth access token.',
              type: 'OAuthException',
              code: 190,
            },
          },
          400,
        ),
      ),
    );

    await expect(service.requestGraph(context, '/me')).rejects.toMatchObject({
      code: 'META_REAUTH_REQUIRED',
    });
    expect(repository.markConnectionReauthRequired).toHaveBeenCalledWith(context.connectionId);
  });

  it('paginates accessible ad accounts by cursor and preserves money in minor units', async () => {
    const { service } = buildService();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'act_1',
              account_id: '1',
              name: 'Primary',
              account_status: 1,
              currency: 'USD',
              timezone_name: 'America/New_York',
              timezone_id: 1,
              timezone_offset_hours_utc: -4,
              amount_spent: '12345',
              balance: '500',
              spend_cap: '999999',
              business: { id: 'biz_1', name: 'Business' },
            },
          ],
          paging: { cursors: { after: 'cursor-2' }, next: 'https://graph.facebook.com/next' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'act_2',
              account_id: '2',
              name: 'Secondary',
              account_status: 1,
              currency: 'EGP',
            },
          ],
          paging: { cursors: {} },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await service.listAdAccounts(context);

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      id: 'act_1',
      amountSpentMinor: 12345n,
      balanceMinor: 500n,
      spendCapMinor: 999999n,
    });
    const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as URL);
    expect(secondUrl.searchParams.get('after')).toBe('cursor-2');
  });
});
