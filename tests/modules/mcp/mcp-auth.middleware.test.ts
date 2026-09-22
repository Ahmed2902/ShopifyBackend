import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  hasStoreAccess: vi.fn(),
}));

vi.mock('../../../src/modules/mcp/mcp-oauth.utils.js', () => ({
  MCP_READ_SCOPE: 'mcp:read',
  mcpIssuer: () => 'https://stride.example',
  verifyMcpAccessToken: mocks.verify,
}));

vi.mock('../../../src/modules/mcp/mcp-oauth.repository.js', () => ({
  mcpOAuthRepository: { hasStoreAccess: mocks.hasStoreAccess },
}));

import { requireMcpAuth } from '../../../src/modules/mcp/mcp-auth.middleware.js';

function request(authorization?: string, context: Record<string, unknown> = {}) {
  return {
    header: vi.fn((name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
    ),
    context,
  };
}

function response() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('requireMcpAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue({
      userId: 'user-a',
      storeId: 'store-a',
      clientId: 'client-a',
      scopes: ['mcp:read'],
    });
    mocks.hasStoreAccess.mockResolvedValue({ role: 'OWNER' });
  });

  it('rejects missing bearer authentication with a non-cacheable MCP OAuth challenge', async () => {
    const req = request();
    const res = response();
    const next = vi.fn();

    await requireMcpAuth(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('oauth-protected-resource/mcp'),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid or expired tokens', async () => {
    mocks.verify.mockRejectedValue(new Error('expired'));
    const req = request('Bearer expired-token');
    const res = response();
    const next = vi.fn();

    await requireMcpAuth(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Invalid or expired Stride MCP access token' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token missing mcp:read', async () => {
    mocks.verify.mockResolvedValue({
      userId: 'user-a',
      storeId: 'store-a',
      clientId: 'client-a',
      scopes: ['offline_access'],
    });
    const req = request('Bearer token');
    const res = response();
    const next = vi.fn();

    await requireMcpAuth(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.hasStoreAccess).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a valid token when store membership has been revoked', async () => {
    mocks.hasStoreAccess.mockResolvedValue(null);
    const req = request('Bearer token');
    const res = response();
    const next = vi.fn();

    await requireMcpAuth(req as never, res as never, next);

    expect(mocks.hasStoreAccess).toHaveBeenCalledWith('user-a', 'store-a');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('uses the token store as the only store authority and overwrites caller context', async () => {
    const req = request('Bearer token', { storeId: 'store-b' });
    const res = response();
    const next = vi.fn();

    await requireMcpAuth(req as never, res as never, next);

    expect(mocks.hasStoreAccess).toHaveBeenCalledWith('user-a', 'store-a');
    expect(req.context).toMatchObject({ userId: 'user-a', storeId: 'store-a', role: 'OWNER' });
    expect(req.context.storeId).not.toBe('store-b');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
