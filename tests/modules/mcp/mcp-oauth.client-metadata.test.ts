import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
import { mcpResource, pkceChallenge } from '../../../src/modules/mcp/mcp-oauth.utils.js';

const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd';
const redirectUri = 'https://client.example/callback';

function repository() {
  return {
    findRegisteredClient: vi.fn().mockResolvedValue(null),
    createRegisteredClient: vi.fn(),
    createAuthorizationRequest: vi.fn().mockImplementation(async (input) => ({
      id: '33333333-3333-4333-8333-333333333333',
      ...input,
      createdAt: new Date(),
      codeChallengeMethod: 'S256',
    })),
    getAuthorizationRequest: vi.fn(),
    deleteAuthorizationRequest: vi.fn(),
    listUserStores: vi.fn(),
    hasStoreAccess: vi.fn(),
    createAuthorizationCode: vi.fn(),
    findAuthorizationCode: vi.fn(),
    consumeAuthorizationCode: vi.fn(),
    createRefreshToken: vi.fn(),
    findRefreshToken: vi.fn(),
    rotateRefreshToken: vi.fn(),
  };
}

function authorizationInput(clientId: string) {
  return {
    clientId,
    redirectUri,
    responseType: 'code',
    scope: 'mcp:read',
    resource: mcpResource(),
    codeChallenge: pkceChallenge(verifier),
    codeChallengeMethod: 'S256',
  };
}

describe('MCP client metadata security', () => {
  beforeEach(() => {
    dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('rejects private CIMD addresses before making an HTTP request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new McpOAuthService(repository() as never);

    await expect(
      service.beginAuthorization(authorizationInput('https://10.0.0.5/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to a private or IPv4-mapped private address', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new McpOAuthService(repository() as never);

    dns.lookup.mockResolvedValueOnce([{ address: '192.168.1.20', family: 4 }]);
    await expect(
      service.beginAuthorization(authorizationInput('https://metadata.example/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });

    dns.lookup.mockResolvedValueOnce([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(
      service.beginAuthorization(authorizationInput('https://metadata.example/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects reserved/non-routable metadata destinations', async () => {
    dns.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new McpOAuthService(repository() as never);

    await expect(
      service.beginAuthorization(authorizationInput('https://metadata.example/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects client metadata URLs with credentials or fragments', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new McpOAuthService(repository() as never);

    await expect(
      service.beginAuthorization(authorizationInput('https://user:pass@metadata.example/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });
    await expect(
      service.beginAuthorization(authorizationInput('https://metadata.example/client.json#fragment')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when client metadata loading times out or otherwise fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const service = new McpOAuthService(repository() as never);

    await expect(
      service.beginAuthorization(authorizationInput('https://metadata.example/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });
  });

  it('rejects client metadata larger than the 64 KiB response ceiling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(64 * 1024 + 1) },
        }),
      ),
    );
    const service = new McpOAuthService(repository() as never);

    await expect(
      service.beginAuthorization(authorizationInput('https://metadata.example/client.json')),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_CLIENT' });
  });

  it('rejects client metadata with excessive redirect URIs', async () => {
    const clientId = 'https://metadata.example/client.json';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            client_id: clientId,
            client_name: 'Too many redirects',
            redirect_uris: Array.from({ length: 21 }, (_, index) => `https://client.example/callback/${index}`),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const service = new McpOAuthService(repository() as never);

    await expect(service.beginAuthorization(authorizationInput(clientId))).rejects.toMatchObject({
      code: 'MCP_INVALID_CLIENT',
    });
  });

  it('rejects redirects and metadata identity that do not match the client document', async () => {
    const clientId = 'https://metadata.example/client.json';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            client_id: 'https://metadata.example/other.json',
            client_name: 'Wrong identity',
            redirect_uris: [redirectUri],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const service = new McpOAuthService(repository() as never);

    await expect(service.beginAuthorization(authorizationInput(clientId))).rejects.toMatchObject({
      code: 'MCP_INVALID_CLIENT',
    });
  });
});
