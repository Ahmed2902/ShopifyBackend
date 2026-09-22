import { describe, expect, it, vi } from 'vitest';
import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
import { mcpResource, pkceChallenge } from '../../../src/modules/mcp/mcp-oauth.utils.js';

const merchantId = '11111111-1111-4111-8111-111111111111';
const storeId = '22222222-2222-4222-8222-222222222222';
const clientId = 'urn:stride:mcp:client:test-suite';
const redirectUri = 'https://client.example/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd';

function repository() {
  return {
    findRegisteredClient: vi.fn().mockResolvedValue({
      clientId,
      clientName: 'Advisor Client',
      redirectUris: [redirectUri],
    }),
    createRegisteredClient: vi.fn(),
    createAuthorizationRequest: vi.fn().mockImplementation(async (input) => ({
      id: '33333333-3333-4333-8333-333333333333',
      ...input,
      createdAt: new Date(),
      codeChallengeMethod: 'S256',
    })),
    getAuthorizationRequest: vi.fn(),
    deleteAuthorizationRequest: vi.fn().mockResolvedValue({ count: 1 }),
    listUserStores: vi.fn().mockResolvedValue([]),
    hasStoreAccess: vi.fn(),
    createAuthorizationCode: vi.fn(),
    consumeAuthorizationCode: vi.fn(),
    createRefreshToken: vi.fn(),
    findRefreshToken: vi.fn(),
    rotateRefreshToken: vi.fn(),
  };
}

describe('McpOAuthService authorization', () => {
  it('requires PKCE S256 and the exact Stride MCP resource', async () => {
    const repo = repository();
    const service = new McpOAuthService(repo as never);
    await expect(
      service.beginAuthorization({
        clientId,
        redirectUri,
        responseType: 'code',
        scope: 'mcp:read offline_access',
        resource: mcpResource(),
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'plain',
      }),
    ).rejects.toMatchObject({ code: 'MCP_PKCE_REQUIRED' });

    const consent = await service.beginAuthorization({
      clientId,
      redirectUri,
      responseType: 'code',
      scope: 'mcp:read offline_access',
      resource: mcpResource(),
      codeChallenge: pkceChallenge(verifier),
      codeChallengeMethod: 'S256',
    });
    expect(consent).toContain('/auth/mcp/authorize');
    expect(repo.createAuthorizationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ resource: mcpResource(), scopes: ['mcp:read', 'offline_access'] }),
    );
  });

  it('refuses to authorize a store outside the signed-in merchant memberships', async () => {
    const repo = repository();
    repo.getAuthorizationRequest.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      clientId,
      clientName: 'Advisor Client',
      redirectUri,
      state: 'opaque-state',
      scopes: ['mcp:read'],
      resource: mcpResource(),
      codeChallenge: pkceChallenge(verifier),
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    repo.hasStoreAccess.mockResolvedValue(null);
    const service = new McpOAuthService(repo as never);

    await expect(
      service.approve(merchantId, '33333333-3333-4333-8333-333333333333', storeId),
    ).rejects.toMatchObject({ code: 'MCP_STORE_FORBIDDEN' });
    expect(repo.createAuthorizationCode).not.toHaveBeenCalled();
  });

  it('advertises only read/offline scopes with PKCE and refresh support', () => {
    const service = new McpOAuthService(repository() as never);
    expect(service.protectedResourceMetadata().scopes_supported).toEqual(['mcp:read', 'offline_access']);
    expect(service.authorizationServerMetadata()).toMatchObject({
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });
});
