import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ACCESS_TTL_SECONDS = 15 * 60;
export const MCP_AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const MCP_AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const MCP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MCP_READ_SCOPE = 'mcp:read';
export const MCP_OFFLINE_SCOPE = 'offline_access';
export const MCP_SUPPORTED_SCOPES = [MCP_READ_SCOPE, MCP_OFFLINE_SCOPE] as const;

export function mcpIssuer() {
  return new URL(env.APP_URL).origin;
}

export function mcpResource() {
  return new URL('/mcp', `${new URL(env.APP_URL).origin}/`).toString();
}

export function opaqueToken(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function parseScopes(value: string | undefined) {
  const requested = (value ?? MCP_READ_SCOPE)
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = [...new Set(requested)];
  if (!scopes.includes(MCP_READ_SCOPE)) scopes.unshift(MCP_READ_SCOPE);
  const unsupported = scopes.filter(
    (scope) => !(MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope),
  );
  if (unsupported.length > 0) {
    throw new AppError(`Unsupported MCP scope: ${unsupported.join(', ')}`, 400, 'MCP_INVALID_SCOPE');
  }
  return scopes;
}

export async function issueMcpAccessToken(input: {
  userId: string;
  storeId: string;
  clientId: string;
  scopes: string[];
  resource: string;
}) {
  return new SignJWT({
    kind: 'mcp_access',
    storeId: input.storeId,
    clientId: input.clientId,
    scopes: input.scopes,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(mcpIssuer())
    .setAudience(input.resource)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyMcpAccessToken(token: string, expectedResource = mcpResource()) {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: mcpIssuer(),
      audience: expectedResource,
      algorithms: ['HS256'],
    });
    if (
      payload.kind !== 'mcp_access' ||
      !payload.sub ||
      typeof payload.storeId !== 'string' ||
      typeof payload.clientId !== 'string' ||
      !Array.isArray(payload.scopes) ||
      !payload.scopes.every((scope) => typeof scope === 'string')
    ) {
      throw new Error('Unexpected MCP token payload');
    }
    return {
      userId: payload.sub,
      storeId: payload.storeId,
      clientId: payload.clientId,
      scopes: payload.scopes as string[],
    };
  } catch {
    throw new AppError('Invalid or expired MCP access token', 401, 'MCP_UNAUTHORIZED');
  }
}

export function accessTokenExpiresIn() {
  return ACCESS_TTL_SECONDS;
}
