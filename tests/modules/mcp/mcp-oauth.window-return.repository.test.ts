import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { McpOAuthRepository } from '../../../src/modules/mcp/mcp-oauth.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const clients: string[] = [];
const repo = new McpOAuthRepository();

describeDatabase('MCP OAuth handoff database claims', () => {
  afterEach(async () => {
    await prisma.mcpAuthorizationCode.deleteMany({ where: { clientId: { in: clients } } });
    await prisma.mcpAuthorizationRequest.deleteMany({ where: { clientId: { in: clients } } });
    clients.length = 0;
  });

  async function pending() {
    const clientId = `window-test:${randomUUID()}`;
    clients.push(clientId);
    return repo.createAuthorizationRequest({
      clientId,
      clientName: 'Test client',
      redirectUri: 'https://client.example/callback',
      state: 'state',
      scopes: ['mcp:read'],
      resource: 'https://api.example/mcp',
      codeChallenge: 'challenge',
      returnTokenHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  it('allows exactly one approval or denial under concurrent decisions', async () => {
    const row = await pending();
    const input = {
      requestId: row.id,
      userId: randomUUID(),
      storeId: randomUUID(),
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      scopes: row.scopes,
      resource: row.resource,
      codeChallenge: row.codeChallenge,
      expiresAt: new Date(Date.now() + 60_000),
      returnUrlCiphertext: 'encrypted-approval',
    };
    const outcomes = await Promise.all([
      repo.claimAuthorizationRequestAndCreateCode({ ...input, codeHash: randomUUID() }),
      repo.claimAuthorizationRequestAndCreateCode({ ...input, codeHash: randomUUID() }),
      repo.completeAuthorizationRequest(row.id, 'encrypted-denial'),
    ]);
    const successes =
      outcomes.slice(0, 2).filter(Boolean).length + (outcomes[2] as { count: number }).count;
    expect(successes).toBe(1);
    const decided = await repo.getAuthorizationRequest(row.id);
    expect(decided?.decidedAt).not.toBeNull();
    expect(decided?.returnUrlCiphertext).toMatch(/^encrypted-/);
    const codes = await prisma.mcpAuthorizationCode.count({ where: { clientId: row.clientId } });
    expect(codes).toBe(outcomes.slice(0, 2).filter(Boolean).length);
  });

  it('rolls back the decision when authorization-code creation fails', async () => {
    const row = await pending();
    const input = {
      codeHash: randomUUID(),
      userId: randomUUID(),
      storeId: randomUUID(),
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      scopes: row.scopes,
      resource: row.resource,
      codeChallenge: row.codeChallenge,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await repo.createAuthorizationCode(input);
    await expect(
      repo.claimAuthorizationRequestAndCreateCode({
        ...input,
        requestId: row.id,
        returnUrlCiphertext: 'encrypted',
      }),
    ).rejects.toThrow();
    const pendingRow = await repo.getAuthorizationRequest(row.id);
    expect(pendingRow?.decidedAt).toBeNull();
    expect(pendingRow?.returnUrlCiphertext).toBeNull();
  });
});
