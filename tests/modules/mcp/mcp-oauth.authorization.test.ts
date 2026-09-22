import { describe, expect, it, vi } from 'vitest';
import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
import { mcpResource, pkceChallenge } from '../../../src/modules/mcp/mcp-oauth.utils.js';

const merchantId = '11111111-1111-4111-8111-111111111111';
const storeId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const clientId = 'urn:stride:mcp:client:test-suite';
const redirectUri = 'https://client.example/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd';

function pendingRequest() {
  return {
    id: requestId,
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
  };
}

function repository() {
  return {
    findRegisteredClient: vi.fn().mockResolvedValue({
      clientId,
      clientName: 'Advisor Client',
      redirectUris: [redirectUri],
    }),
    createRegisteredClient: vi.fn(),
    createAuthorizationRequest: vi.fn().mockImplementation(async (input) => ({
      id: requestId,
      ...input,
      createdAt: new Date(),
      codeChallengeMethod: 'S256',
    })),
    getAuthorizationRequest: vi.fn(),
    deleteAuthorizationRequest: vi.fn().mockResolvedValue({ count: 1 }),
    listUserStores: vi.fn().mockResolvedValue([]),
    hasStoreAccess: vi.fn(),
    createAuthorizationCode: vi.fn(),
    claimAuthorizationRequestAndCreateCode: vi.fn().mockResolvedValue({ id: 'code-row' }),
    findAuthorizationCode: vi.fn(),
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
    repo.getAuthorizationRequest.mockResolvedValue(pendingRequest());
    repo.hasStoreAccess.mockResolvedValue(null);
    const service = new McpOAuthService(repo as never);

    await expect(service.approve(merchantId, requestId, storeId)).rejects.toMatchObject({
      code: 'MCP_STORE_FORBIDDEN',
    });
    expect(repo.claimAuthorizationRequestAndCreateCode).not.toHaveBeenCalled();
  });

  it('claims the authorization request atomically before issuing the redirect code', async () => {
    const repo = repository();
    repo.getAuthorizationRequest.mockResolvedValue(pendingRequest());
    repo.hasStoreAccess.mockResolvedValue({ role: 'OWNER' });
    const service = new McpOAuthService(repo as never);

    const redirect = await service.approve(merchantId, requestId, storeId);
    expect(repo.claimAuthorizationRequestAndCreateCode).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, userId: merchantId, storeId, clientId }),
    );
    expect(redirect).toContain('code=');

    repo.claimAuthorizationRequestAndCreateCode.mockResolvedValue(null);
    await expect(service.approve(merchantId, requestId, storeId)).rejects.toMatchObject({
      code: 'MCP_AUTH_REQUEST_EXPIRED',
    });
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
