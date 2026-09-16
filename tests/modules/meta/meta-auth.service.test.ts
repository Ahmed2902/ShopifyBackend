import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env.js';
import type { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { MetaAuthService } from '../../../src/modules/meta/shared/meta-auth.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';
import { createMetaOAuthState } from '../../../src/modules/meta/meta.utils.js';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requestedScopes = ['ads_read', 'business_management', 'catalog_management'];

function build(options?: { role?: 'OWNER' | 'ADMIN' | 'MEMBER'; scopes?: string[] }) {
  const scopes = options?.scopes ?? requestedScopes;
  const repository = {
    findMembership: vi.fn().mockResolvedValue({ role: options?.role ?? 'OWNER' }),
    upsertConnection: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        id: connectionId,
        storeId,
        metaUserId: 'meta-user-1',
        metaBusinessId: null,
        selectedAdAccountIds: [],
        selectedCatalogIds: [],
        scopes: input.scopes,
        apiVersion: input.apiVersion,
        tokenExpiresAt: input.tokenExpiresAt,
      }),
    ),
    findConnectionForStore: vi.fn(),
    markConnectionReauthRequired: vi.fn().mockResolvedValue(undefined),
  } as unknown as MetaRepository;

  const apiService = {
    exchangeAuthorizationCode: vi.fn().mockResolvedValue({
      accessToken: 'long-lived-meta-token',
      expiresInSeconds: 5_184_000,
    }),
    inspectAccessToken: vi.fn().mockResolvedValue({
      appId: 'test-meta-app-id',
      userId: 'meta-user-1',
      isValid: true,
      expiresAt: new Date(Date.now() + 5_184_000_000),
      scopes,
    }),
  } as unknown as MetaApiService;

  return { repository, apiService, service: new MetaAuthService(repository, apiService) };
}

afterEach(() => {
  vi.restoreAllMocks();
  env.NODE_ENV = 'test';
  env.META_SANDBOX_ACCESS_TOKEN = undefined;
  env.META_SANDBOX_AD_ACCOUNT_ID = undefined;
  env.META_SANDBOX_API_VERSION = undefined;
});

describe('MetaAuthService', () => {
  it('requires an owner or admin before starting OAuth', async () => {
    const { service } = build({ role: 'MEMBER' });
    await expect(service.startInstall(userId, storeId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('stores only an encrypted long-lived token after validating Meta token metadata', async () => {
    const { repository, apiService, service } = build();
    const state = createMetaOAuthState(userId, storeId);

    const result = await service.completeInstall('oauth-code', state);

    expect(apiService.exchangeAuthorizationCode).toHaveBeenCalledWith('oauth-code');
    expect(apiService.inspectAccessToken).toHaveBeenCalledWith('long-lived-meta-token');
    expect(repository.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        metaUserId: 'meta-user-1',
        scopes: requestedScopes,
        apiVersion: 'v26.0',
        accessTokenCiphertext: expect.any(String),
      }),
    );
    const persisted = vi.mocked(repository.upsertConnection).mock.calls[0]?.[0];
    expect(persisted?.accessTokenCiphertext).not.toContain('long-lived-meta-token');
    expect(result).toMatchObject({ storeId, connectionId, metaUserId: 'meta-user-1' });
  });

  it('accepts a base Meta connection when ads_read is granted without optional business/catalog scopes', async () => {
    const { repository, service } = build({ scopes: ['ads_read'] });
    const state = createMetaOAuthState(userId, storeId);

    await expect(service.completeInstall('oauth-code', state)).resolves.toMatchObject({
      storeId,
      connectionId,
      scopes: ['ads_read'],
    });
    expect(repository.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['ads_read'] }),
    );
  });

  it('rejects OAuth completion if ads_read was not granted', async () => {
    const { repository, service } = build({
      scopes: ['business_management', 'catalog_management'],
    });
    const state = createMetaOAuthState(userId, storeId);

    await expect(service.completeInstall('oauth-code', state)).rejects.toMatchObject({
      code: 'META_ADS_READ_REQUIRED',
    });
    expect(repository.upsertConnection).not.toHaveBeenCalled();
  });

  it('routes development Meta API context to the configured sandbox account and token', async () => {
    const { repository, service } = build();
    vi.mocked(repository.findConnectionForStore).mockResolvedValue({
      id: connectionId,
      storeId,
      status: 'ACTIVE',
      metaUserId: 'meta-user-1',
      metaBusinessId: 'real-business-id',
      selectedAdAccountIds: ['act-real-account'],
      selectedCatalogIds: ['real-catalog-id'],
      accessTokenCiphertext: 'real-token-ciphertext',
      tokenExpiresAt: new Date(Date.now() - 60_000),
      scopes: requestedScopes,
      apiVersion: 'v26.0',
      lastSyncedAt: null,
      adAccounts: [],
    } as never);

    env.NODE_ENV = 'development';
    env.META_SANDBOX_ACCESS_TOKEN = 'sandbox-token';
    env.META_SANDBOX_AD_ACCOUNT_ID = 'act-sandbox-account';
    env.META_SANDBOX_API_VERSION = 'v26.0';

    await expect(service.getApiContext(storeId)).resolves.toEqual({
      storeId,
      connectionId,
      accessToken: 'sandbox-token',
      apiVersion: 'v26.0',
      scopes: requestedScopes,
      metaBusinessId: null,
      selectedAdAccountIds: ['act-sandbox-account'],
      selectedCatalogIds: [],
    });
    expect(repository.markConnectionReauthRequired).not.toHaveBeenCalled();
  });

  it('fails closed when development sandbox credentials are missing', async () => {
    const { repository, service } = build();
    vi.mocked(repository.findConnectionForStore).mockResolvedValue({
      id: connectionId,
      storeId,
      status: 'ACTIVE',
      metaUserId: 'meta-user-1',
      metaBusinessId: null,
      selectedAdAccountIds: ['act-real-account'],
      selectedCatalogIds: [],
      accessTokenCiphertext: 'real-token-ciphertext',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ['ads_read'],
      apiVersion: 'v26.0',
      lastSyncedAt: null,
      adAccounts: [],
    } as never);

    env.NODE_ENV = 'development';
    env.META_SANDBOX_ACCESS_TOKEN = undefined;
    env.META_SANDBOX_AD_ACCOUNT_ID = undefined;

    await expect(service.getApiContext(storeId)).rejects.toMatchObject({
      code: 'META_SANDBOX_NOT_CONFIGURED',
    });
  });

  it('marks an active stored connection for reauthorization when the base ads_read permission is missing', async () => {
    const { repository, service } = build();
    vi.mocked(repository.findConnectionForStore).mockResolvedValue({
      id: connectionId,
      storeId,
      status: 'ACTIVE',
      metaUserId: 'meta-user-1',
      metaBusinessId: null,
      selectedAdAccountIds: [],
      selectedCatalogIds: [],
      accessTokenCiphertext: 'unused',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      scopes: ['business_management', 'catalog_management'],
      apiVersion: 'v26.0',
      lastSyncedAt: null,
      adAccounts: [],
    } as never);

    await expect(service.getApiContext(storeId)).rejects.toMatchObject({
      code: 'META_ADS_READ_REQUIRED',
    });
    expect(repository.markConnectionReauthRequired).toHaveBeenCalledWith(connectionId);
  });

  it('marks an expired stored token for reauthorization before returning it', async () => {
    const { repository, service } = build();
    vi.mocked(repository.findConnectionForStore).mockResolvedValue({
      id: connectionId,
      storeId,
      status: 'ACTIVE',
      metaUserId: 'meta-user-1',
      metaBusinessId: null,
      selectedAdAccountIds: [],
      selectedCatalogIds: [],
      accessTokenCiphertext: 'unused',
      tokenExpiresAt: new Date(Date.now() - 1_000),
      scopes: requestedScopes,
      apiVersion: 'v26.0',
      lastSyncedAt: null,
      adAccounts: [],
    } as never);

    await expect(service.getApiContext(storeId)).rejects.toMatchObject({
      code: 'META_REAUTH_REQUIRED',
    });
    expect(repository.markConnectionReauthRequired).toHaveBeenCalledWith(connectionId);
  });
});
