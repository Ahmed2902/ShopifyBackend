import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAdsApiService } from '../../../src/modules/google-ads/shared/google-ads-api.service.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Google Ads API transport', () => {
  it('uses v25 fixed-size search pagination and required Google Ads headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ campaign: { id: '1' } }], nextPageToken: 'next' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ campaign: { id: '2' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const rows = await new GoogleAdsApiService().search({
      accessToken: 'access-token',
      apiVersion: 'v25',
      customerId: '123-456-7890',
      loginCustomerId: '999-888-7777',
      query: 'SELECT campaign.id FROM campaign',
    });

    expect(rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]![1] as RequestInit;
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(String(first.body))).toEqual({ query: 'SELECT campaign.id FROM campaign' });
    expect(JSON.parse(String(second.body))).toEqual({
      query: 'SELECT campaign.id FROM campaign',
      pageToken: 'next',
    });
    expect(first.headers).toMatchObject({
      'developer-token': 'test-google-ads-developer-token',
      'login-customer-id': '9998887777',
    });
  });

  it('uses the developer token but no login-customer-id for accessible-customer discovery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resourceNames: ['customers/1234567890'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new GoogleAdsApiService().listAccessibleCustomers('access-token', 'v25'),
    ).resolves.toEqual(['1234567890']);

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.headers).toMatchObject({
      'developer-token': 'test-google-ads-developer-token',
    });
    expect(request.headers).not.toHaveProperty('login-customer-id');
  });

  it('does not collapse Cloud-project API authorization failures into OAuth reauth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              details: [
                {
                  errors: [
                    {
                      errorCode: {
                        authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION',
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(
      new GoogleAdsApiService().listAccessibleCustomers('access-token', 'v25'),
    ).rejects.toMatchObject({
      code: 'GOOGLE_ADS_API_ACCESS_NOT_APPROVED',
      statusCode: 403,
    });
  });

  it('maps an expired bearer credential to reauthorization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      new GoogleAdsApiService().listAccessibleCustomers('expired-token', 'v25'),
    ).rejects.toMatchObject({ code: 'GOOGLE_ADS_REAUTH_REQUIRED', statusCode: 401 });
  });
});
