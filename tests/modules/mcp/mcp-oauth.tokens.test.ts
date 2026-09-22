import { describe, expect, it, vi } from 'vitest';
import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
import { mcpResource, pkceChallenge } from '../../../src/modules/mcp/mcp-oauth.utils.js';

const merchantId = '11111111-1111-4111-8111-111111111111';
const storeId = '22222222-2222-4222-8222-222222222222';
const clientId = 'urn:stride:mcp:client:rotation-suite';
const redirectUri = 'https://client.example/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd';

function authorizationCode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'code-row',
    codeHash: 'digest',
    userId: merchantId,
    storeId,
    clientId,
    redirectUri,
    scopes: ['mcp:read', 'offline_access'],
    resource: mcpResource(),
    codeChallenge: pkceChallenge(verifier),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function repository() {
  const code = authorizationCode();
  return {
    findRegisteredClient: vi.fn(),
    createRegisteredClient: vi.fn(),
    createAuthorizationRequest: vi.fn(),
    getAuthorizationRequest: vi.fn(),
    deleteAuthorizationRequest: vi.fn(),
    listUserStores: vi.fn(),
    hasStoreAccess: vi.fn().mockResolvedValue({ role: 'OWNER' }),
    createAuthorizationCode: vi.fn(),
    findAuthorizationCode: vi.fn().mockResolvedValue(code),
    consumeAuthorizationCode: vi.fn().mockResolvedValue({ ...code, usedAt: new Date() }),
    createRefreshToken: vi.fn().mockResolvedValue({}),
    findRefreshToken: vi.fn(),
    rotateRefreshToken: vi.fn(),
  };
}

describe('McpOAuthService tokens', () => {
  it('validates PKCE and current store access before atomically consuming a one-time authorization code', async () => {
    const repo = repository();
    const service = new McpOAuthService(repo as never);

    await expect(
      service.exchangeAuthorizationCode({
        code: 'authorization-code',
        clientId,
        redirectUri,
        codeVerifier: `${verifier}wrong`,
        resource: mcpResource(),
      }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
    expect(repo.consumeAuthorizationCode).not.toHaveBeenCalled();
    expect(repo.hasStoreAccess).not.toHaveBeenCalled();

    const response = await service.exchangeAuthorizationCode({
      code: 'authorization-code',
      clientId,
      redirectUri,
      codeVerifier: verifier,
      resource: mcpResource(),
    });
    expect(response).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(response.access_token).toEqual(expect.any(String));
    expect(response.refresh_token).toEqual(expect.any(String));
    expect(repo.hasStoreAccess).toHaveBeenCalledWith(merchantId, storeId);
    expect(repo.consumeAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(repo.createRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: merchantId, storeId, clientId, resource: mcpResource() }),
    );
  });

  it.each([
    ['expired code', { expiresAt: new Date(Date.now() - 1_000) }, clientId, redirectUri, mcpResource()],
    ['used code', { usedAt: new Date() }, clientId, redirectUri, mcpResource()],
    ['wrong client', {}, 'urn:stride:mcp:client:other', redirectUri, mcpResource()],
    ['wrong redirect', {}, clientId, 'https://client.example/other', mcpResource()],
    ['wrong resource', {}, clientId, redirectUri, 'https://other.example/mcp'],
  ])('rejects %s without consuming the authorization code', async (_name, overrides, requestClient, requestRedirect, resource) => {
    const repo = repository();
    repo.findAuthorizationCode.mockResolvedValue(authorizationCode(overrides as Record<string, unknown>));
    const service = new McpOAuthService(repo as never);

    await expect(
      service.exchangeAuthorizationCode({
        code: 'authorization-code',
        clientId: requestClient as string,
        redirectUri: requestRedirect as string,
        codeVerifier: verifier,
        resource: resource as string,
      }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
    expect(repo.consumeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('rejects authorization-code redemption when store membership was revoked after consent', async () => {
    const repo = repository();
    repo.hasStoreAccess.mockResolvedValue(null);
    const service = new McpOAuthService(repo as never);

    await expect(
      service.exchangeAuthorizationCode({
        code: 'authorization-code',
        clientId,
        redirectUri,
        codeVerifier: verifier,
        resource: mcpResource(),
      }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });

    expect(repo.hasStoreAccess).toHaveBeenCalledWith(merchantId, storeId);
    expect(repo.consumeAuthorizationCode).not.toHaveBeenCalled();
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects code reuse when the atomic claim loses the race', async () => {
    const repo = repository();
    repo.consumeAuthorizationCode.mockResolvedValue(null);
    const service = new McpOAuthService(repo as never);

    await expect(
      service.exchangeAuthorizationCode({
        code: 'authorization-code',
        clientId,
        redirectUri,
        codeVerifier: verifier,
        resource: mcpResource(),
      }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
  });

  it('rotates refresh grants so replay cannot succeed', async () => {
    const repo = repository();
    const current = {
      id: 'refresh-row',
      tokenHash: 'digest',
      userId: merchantId,
      storeId,
      clientId,
      scopes: ['mcp:read', 'offline_access'],
      resource: mcpResource(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      createdAt: new Date(),
    };
    repo.findRefreshToken.mockResolvedValue(current);
    repo.rotateRefreshToken.mockResolvedValue({ ...current, id: 'replacement-row' });
    const service = new McpOAuthService(repo as never);

    const response = await service.refresh({
      refreshToken: 'refresh-grant',
      clientId,
      resource: mcpResource(),
    });
    expect(response.refresh_token).toEqual(expect.any(String));
    expect(repo.hasStoreAccess).toHaveBeenCalledWith(merchantId, storeId);

    repo.rotateRefreshToken.mockResolvedValue(null);
    await expect(
      service.refresh({ refreshToken: 'refresh-grant', clientId, resource: mcpResource() }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
  });

  it('rejects refresh when the user no longer has access to the store', async () => {
    const repo = repository();
    const current = {
      id: 'refresh-row',
      tokenHash: 'digest',
      userId: merchantId,
      storeId,
      clientId,
      scopes: ['mcp:read', 'offline_access'],
      resource: mcpResource(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      createdAt: new Date(),
    };
    repo.findRefreshToken.mockResolvedValue(current);
    repo.hasStoreAccess.mockResolvedValue(null);
    const service = new McpOAuthService(repo as never);

    await expect(
      service.refresh({ refreshToken: 'refresh-grant', clientId, resource: mcpResource() }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });

    expect(repo.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects refresh tokens bound to another client or resource', async () => {
    const repo = repository();
    const current = {
      id: 'refresh-row',
      tokenHash: 'digest',
      userId: merchantId,
      storeId,
      clientId,
      scopes: ['mcp:read', 'offline_access'],
      resource: mcpResource(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      createdAt: new Date(),
    };
    repo.findRefreshToken.mockResolvedValue(current);
    const service = new McpOAuthService(repo as never);

    await expect(
      service.refresh({ refreshToken: 'refresh-grant', clientId: 'other-client', resource: mcpResource() }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
    await expect(
      service.refresh({ refreshToken: 'refresh-grant', clientId, resource: 'https://other.example/mcp' }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
    expect(repo.hasStoreAccess).not.toHaveBeenCalled();
    expect(repo.rotateRefreshToken).not.toHaveBeenCalled();
  });
});
