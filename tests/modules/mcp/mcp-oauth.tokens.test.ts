import { describe, expect, it, vi } from 'vitest';
import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
import { mcpResource, pkceChallenge } from '../../../src/modules/mcp/mcp-oauth.utils.js';

const merchantId = '11111111-1111-4111-8111-111111111111';
const storeId = '22222222-2222-4222-8222-222222222222';
const clientId = 'urn:stride:mcp:client:rotation-suite';
const redirectUri = 'https://client.example/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd';

function repository() {
  return {
    findRegisteredClient: vi.fn(),
    createRegisteredClient: vi.fn(),
    createAuthorizationRequest: vi.fn(),
    getAuthorizationRequest: vi.fn(),
    deleteAuthorizationRequest: vi.fn(),
    listUserStores: vi.fn(),
    hasStoreAccess: vi.fn(),
    createAuthorizationCode: vi.fn(),
    consumeAuthorizationCode: vi.fn().mockResolvedValue({
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
    }),
    createRefreshToken: vi.fn().mockResolvedValue({}),
    findRefreshToken: vi.fn(),
    rotateRefreshToken: vi.fn(),
  };
}

describe('McpOAuthService tokens', () => {
  it('exchanges a one-time code only with matching PKCE and bindings', async () => {
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
    expect(repo.createRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: merchantId, storeId, clientId, resource: mcpResource() }),
    );
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

    repo.rotateRefreshToken.mockResolvedValue(null);
    await expect(
      service.refresh({ refreshToken: 'refresh-grant', clientId, resource: mcpResource() }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_GRANT' });
  });
});
