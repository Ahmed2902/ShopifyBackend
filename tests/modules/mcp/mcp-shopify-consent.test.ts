import { describe, expect, it, vi } from 'vitest';
import { McpOAuthController } from '../../../src/modules/mcp/mcp-oauth.controller.js';
import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
const requestId = '33333333-3333-4333-8333-333333333333';
const storeId = '22222222-2222-4222-8222-222222222222';
const otherStoreId = '44444444-4444-4444-8444-444444444444';
const pending = { id: requestId, clientId: 'client', clientName: 'AI client', redirectUri: 'https://client.example/callback', scopes: ['mcp:read'], expiresAt: new Date(Date.now() + 60_000) };
const response = () => ({ setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
describe('Shopify MCP consent boundaries', () => {
  it.each(['ftp://localhost/callback', 'javascript://localhost/callback'])('rejects unsafe callback protocol %s', async (redirectUri) => {
    const repo = { createRegisteredClient: vi.fn() };
    await expect(new McpOAuthService(repo as never).registerClient({ redirect_uris: [redirectUri] })).rejects.toMatchObject({ code: 'MCP_INVALID_REDIRECT_URI' });
    expect(repo.createRegisteredClient).not.toHaveBeenCalled();
  });
  it('accepts an HTTP IPv6 loopback callback', async () => {
    const repo = { createRegisteredClient: vi.fn().mockResolvedValue({}) };
    const result = await new McpOAuthService(repo as never).registerClient({ redirect_uris: ['http://[::1]:1234/callback'] });
    expect(result.redirect_uris).toEqual(['http://[::1]:1234/callback']);
  });
  it('exposes the registered callback and only the authenticated store', async () => {
    const repo = { getAuthorizationRequest: vi.fn().mockResolvedValue(pending), listUserStores: vi.fn().mockResolvedValue([
      { role: 'OWNER', store: { id: storeId, name: 'Current shop' } },
      { role: 'OWNER', store: { id: otherStoreId, name: 'Other shop' } },
    ]) };
    const result = await new McpOAuthService(repo as never).authorizationRequest('user', requestId, storeId);
    expect(result.redirectUri).toBe(pending.redirectUri);
    expect(result.stores).toEqual([{ id: storeId, name: 'Current shop', role: 'OWNER' }]);
  });
  it('passes trusted Shopify context to the consent read', async () => {
    const service = { authorizationRequest: vi.fn().mockResolvedValue({}) };
    await new McpOAuthController(service as never).authorizationRequest({ params: { requestId }, context: { userId: 'user', storeId, authSource: 'SHOPIFY' } } as never, response() as never);
    expect(service.authorizationRequest).toHaveBeenCalledWith('user', requestId, storeId);
  });
  it('rejects a different store even if the user has a persisted membership', async () => {
    const service = { approve: vi.fn() };
    await expect(new McpOAuthController(service as never).approve({ params: { requestId }, body: { storeId: otherStoreId }, context: { userId: 'user', storeId, authSource: 'SHOPIFY' } } as never, response() as never)).rejects.toMatchObject({ statusCode: 403, code: 'MCP_STORE_FORBIDDEN' });
    expect(service.approve).not.toHaveBeenCalled();
  });
  it('fails closed if Shopify store context is missing', async () => {
    const service = { authorizationRequest: vi.fn() };
    await expect(new McpOAuthController(service as never).authorizationRequest({ params: { requestId }, context: { userId: 'user', authSource: 'SHOPIFY' } } as never, response() as never)).rejects.toMatchObject({ code: 'MCP_STORE_FORBIDDEN' });
    expect(service.authorizationRequest).not.toHaveBeenCalled();
  });
  it('returns access_denied only after atomically claiming the pending request', async () => {
    const repo = { getAuthorizationRequest: vi.fn().mockResolvedValue(pending), deleteAuthorizationRequest: vi.fn().mockResolvedValue({ count: 0 }) };
    await expect(new McpOAuthService(repo as never).deny('user', requestId)).rejects.toMatchObject({ code: 'MCP_AUTH_REQUEST_EXPIRED' });
  });
});
