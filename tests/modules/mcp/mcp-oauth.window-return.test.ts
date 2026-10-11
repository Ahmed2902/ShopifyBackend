import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { McpOAuthController } from '../../../src/modules/mcp/mcp-oauth.controller.js';
import { McpOAuthService } from '../../../src/modules/mcp/mcp-oauth.service.js';
import {
  mcpIssuer,
  mcpResource,
  pkceChallenge,
  tokenHash,
} from '../../../src/modules/mcp/mcp-oauth.utils.js';
import {
  decryptSecret,
  encryptSecret,
} from '../../../src/modules/integrations/integration.utils.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const id = '33333333-3333-4333-8333-333333333333';
const userId = '11111111-1111-4111-8111-111111111111';
const storeId = '22222222-2222-4222-8222-222222222222';
const redirectUri = 'https://client.example/callback?client_context=keep';
const clientId = 'urn:test:client';
const verifier = 'v'.repeat(64);
const returnToken = 't'.repeat(43);
const pending = () => ({
  id,
  clientId,
  clientName: 'AI client',
  redirectUri,
  state: 'opaque-client-state',
  scopes: ['mcp:read'],
  resource: mcpResource(),
  codeChallenge: pkceChallenge(verifier),
  expiresAt: new Date(Date.now() + 60_000),
  decidedAt: null as Date | null,
  returnTokenHash: tokenHash(returnToken),
  returnUrlCiphertext: null as string | null,
});

describe('MCP original OAuth window return', () => {
  it('puts a fresh capability only in the handoff fragment and stores only its digest', async () => {
    const repo = {
      findRegisteredClient: vi
        .fn()
        .mockResolvedValue({ clientId, clientName: 'AI client', redirectUris: [redirectUri] }),
      createAuthorizationRequest: vi.fn().mockImplementation(async (input) => ({ id, ...input })),
    };
    const service = new McpOAuthService(repo as never);
    const url = new URL(
      await service.beginAuthorization({
        clientId,
        redirectUri,
        state: 'state',
        responseType: 'code',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
      }),
    );
    const token = new URLSearchParams(url.hash.slice(1)).get('return_token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('request_id')).toBe(id);
    expect(url.searchParams.has('return_token')).toBe(false);
    expect(repo.createAuthorizationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ returnTokenHash: tokenHash(token) }),
    );
    expect(JSON.stringify(repo.createAuthorizationRequest.mock.calls)).not.toContain(token);
  });

  it('does not expose results to a request ID alone, another capability or an expired handoff', async () => {
    const repo = { getAuthorizationRequest: vi.fn().mockResolvedValue(pending()) };
    const service = new McpOAuthService(repo as never);
    await expect(service.authorizationResult(id, 'wrong')).rejects.toMatchObject({
      code: 'MCP_INVALID_RETURN',
    });
    await expect(service.authorizationResult(id, returnToken)).resolves.toEqual({
      status: 'PENDING',
    });
    repo.getAuthorizationRequest.mockResolvedValue({ ...pending(), expiresAt: new Date(0) });
    await expect(service.authorizationResult(id, returnToken)).rejects.toMatchObject({
      code: 'MCP_INVALID_RETURN',
    });
    repo.getAuthorizationRequest.mockResolvedValue({
      ...pending(),
      returnTokenHash: null,
    } as never);
    await expect(service.authorizationResult(id, returnToken)).rejects.toMatchObject({
      code: 'MCP_INVALID_RETURN',
    });
  });

  it('encrypts the approved callback, preserves state and issuer, and safely retries result reads', async () => {
    const record = pending();
    const repo = {
      getAuthorizationRequest: vi.fn().mockResolvedValue(record),
      hasStoreAccess: vi.fn().mockResolvedValue({ role: 'OWNER' }),
      claimAuthorizationRequestAndCreateCode: vi.fn().mockImplementation(async (input) => {
        record.decidedAt = new Date();
        record.returnUrlCiphertext = input.returnUrlCiphertext;
        return { id: 'code' };
      }),
      deleteAuthorizationRequest: vi.fn(),
    };
    const service = new McpOAuthService(repo as never);
    const callback = new URL(await service.approve(userId, id, storeId));
    expect(callback.searchParams.get('state')).toBe(record.state);
    expect(callback.searchParams.get('iss')).toBe(mcpIssuer());
    expect(callback.searchParams.get('client_context')).toBe('keep');
    expect(record.returnUrlCiphertext).not.toContain(callback.searchParams.get('code')!);
    expect(decryptSecret(record.returnUrlCiphertext!)).toBe(callback.toString());
    const complete = { status: 'COMPLETE', redirectUrl: callback.toString(), redirectUri };
    await expect(service.authorizationResult(id, returnToken)).resolves.toEqual(complete);
    await expect(service.authorizationResult(id, returnToken)).resolves.toEqual(complete);
    await expect(service.approve(userId, id, storeId)).rejects.toMatchObject({
      code: 'MCP_AUTH_REQUEST_EXPIRED',
    });
    await expect(service.authorizationRequest(userId, id, storeId)).rejects.toMatchObject({
      code: 'MCP_AUTH_REQUEST_EXPIRED',
    });
    expect(repo.deleteAuthorizationRequest).not.toHaveBeenCalled();
    expect(repo.claimAuthorizationRequestAndCreateCode).toHaveBeenCalledTimes(1);
  });

  it('returns a denial with the same state through the original window without issuing a code', async () => {
    const record = pending();
    const repo = {
      getAuthorizationRequest: vi.fn().mockResolvedValue(record),
      completeAuthorizationRequest: vi.fn().mockImplementation(async (_id, ciphertext) => {
        record.decidedAt = new Date();
        record.returnUrlCiphertext = ciphertext;
        return { count: 1 };
      }),
    };
    const service = new McpOAuthService(repo as never);
    const callback = new URL(await service.deny(userId, id));
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(record.state);
    expect(callback.searchParams.has('code')).toBe(false);
    await expect(service.authorizationResult(id, returnToken)).resolves.toMatchObject({
      status: 'COMPLETE',
      redirectUrl: callback.toString(),
    });
  });

  it('never exposes the return capability or encrypted result in Shopify consent metadata', async () => {
    const repo = {
      getAuthorizationRequest: vi.fn().mockResolvedValue(pending()),
      listUserStores: vi.fn().mockResolvedValue([]),
    };
    const view = await new McpOAuthService(repo as never).authorizationRequest(userId, id, storeId);
    expect(view.returnViaAuthorizationWindow).toBe(true);
    expect(view).not.toHaveProperty('returnTokenHash');
    expect(view).not.toHaveProperty('returnUrlCiphertext');
  });

  it('allows capability-proven result polling without merchant login and marks responses no-store', async () => {
    const repo = {
      getAuthorizationRequest: vi
        .fn()
        .mockResolvedValue({
          ...pending(),
          decidedAt: new Date(),
          returnUrlCiphertext: encryptSecret(`${redirectUri}&error=access_denied`),
        }),
    };
    const controller = new McpOAuthController(new McpOAuthService(repo as never));
    const app = express();
    app.use(express.json());
    app.post('/oauth/authorization-requests/:requestId/result', controller.authorizationResult);
    app.use(errorHandler);
    const result = await request(app)
      .post(`/oauth/authorization-requests/${id}/result`)
      .send({ returnToken });
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.status).toBe('COMPLETE');
    const invalid = await request(app)
      .post(`/oauth/authorization-requests/${id}/result`)
      .send({ returnToken: 'x'.repeat(43) });
    expect(invalid.status).toBe(400);
    expect(invalid.body).not.toHaveProperty('redirectUrl');
  });
});
