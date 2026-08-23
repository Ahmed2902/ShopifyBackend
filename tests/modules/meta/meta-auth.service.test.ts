import { describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { MetaAuthService } from '../../../src/modules/meta/shared/meta-auth.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';
import { createMetaOAuthState } from '../../../src/modules/meta/meta.utils.js';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requiredScopes = ['ads_read', 'business_management', 'catalog_management'];

function build(options?: { role?: 'OWNER' | 'ADMIN' | 'MEMBER'; scopes?: string[] }) {
  const scopes = options?.scopes ?? requiredScopes;
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
        scopes: requiredScopes,
        apiVersion: 'v26.0',
        accessTokenCiphertext: expect.any(String),
      }),
    );
    const persisted = vi.mocked(repository.upsertConnection).mock.calls[0]?.[0];
    expect(persisted?.accessTokenCiphertext).not.toContain('long-lived-meta-token');
    expect(result).toMatchObject({ storeId, connectionId, metaUserId: 'meta-user-1' });
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

  it('rejects OAuth completion if business_management was not granted', async () => {
    const { repository, service } = build({ scopes: ['ads_read', 'catalog_management'] });
    const state = createMetaOAuthState(userId, storeId);

    await expect(service.completeInstall('oauth-code', state)).rejects.toMatchObject({
      code: 'META_BUSINESS_PERMISSION_REQUIRED',
    });
    expect(repository.upsertConnection).not.toHaveBeenCalled();
  });

  it('rejects OAuth completion if catalog_management was not granted', async () => {
    const { repository, service } = build({ scopes: ['ads_read', 'business_management'] });
    const state = createMetaOAuthState(userId, storeId);

    await expect(service.completeInstall('oauth-code', state)).rejects.toMatchObject({
      code: 'META_CATALOG_PERMISSION_REQUIRED',
    });
    expect(repository.upsertConnection).not.toHaveBeenCalled();
  });

  it('marks an active stored connection for reauthorization if a required permission is missing', async () => {
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
      scopes: ['ads_read', 'business_management'],
      apiVersion: 'v26.0',
      lastSyncedAt: null,
      adAccounts: [],
    } as never);

    await expect(service.getApiContext(storeId)).rejects.toMatchObject({
      code: 'META_CATALOG_PERMISSION_REQUIRED',
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
      scopes: requiredScopes,
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
