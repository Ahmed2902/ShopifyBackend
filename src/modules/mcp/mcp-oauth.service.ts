import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { mcpOAuthRepository, type McpOAuthRepository } from './mcp-oauth.repository.js';
import {
  accessTokenExpiresIn,
  issueMcpAccessToken,
  MCP_AUTHORIZATION_CODE_TTL_MS,
  MCP_AUTHORIZATION_REQUEST_TTL_MS,
  MCP_OFFLINE_SCOPE,
  MCP_READ_SCOPE,
  MCP_REFRESH_TOKEN_TTL_MS,
  mcpIssuer,
  mcpResource,
  opaqueToken,
  parseScopes,
  pkceChallenge,
  tokenHash,
} from './mcp-oauth.utils.js';

interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

function privateIp(address: string) {
  if (address === '::1') return true;
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

async function assertSafeMetadataUrl(url: URL) {
  if (url.protocol !== 'https:') {
    if (env.NODE_ENV !== 'production' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
      return;
    }
    throw new AppError('MCP client metadata URL must use HTTPS', 400, 'MCP_INVALID_CLIENT');
  }
  if (isIP(url.hostname) && privateIp(url.hostname)) {
    throw new AppError('Private MCP client metadata addresses are not allowed', 400, 'MCP_INVALID_CLIENT');
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some((entry) => privateIp(entry.address))) {
    throw new AppError('Private MCP client metadata addresses are not allowed', 400, 'MCP_INVALID_CLIENT');
  }
}

export class McpOAuthService {
  constructor(private readonly repository: McpOAuthRepository = mcpOAuthRepository) {}

  protectedResourceMetadata() {
    return {
      resource: mcpResource(),
      authorization_servers: [mcpIssuer()],
      scopes_supported: [MCP_READ_SCOPE, MCP_OFFLINE_SCOPE],
      bearer_methods_supported: ['header'],
    };
  }

  authorizationServerMetadata() {
    const issuer = mcpIssuer();
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [MCP_READ_SCOPE, MCP_OFFLINE_SCOPE],
      client_id_metadata_document_supported: true,
    };
  }

  async registerClient(input: { client_name?: string; redirect_uris?: string[] }) {
    const redirectUris = input.redirect_uris ?? [];
    if (redirectUris.length === 0 || redirectUris.length > 20) {
      throw new AppError('redirect_uris is required', 400, 'MCP_INVALID_CLIENT_METADATA');
    }
    for (const value of redirectUris) this.validateRedirectUri(value);
    const clientId = `urn:stride:mcp:client:${randomUUID()}`;
    const clientName = input.client_name?.trim().slice(0, 120) || 'MCP client';
    await this.repository.createRegisteredClient({ clientId, clientName, redirectUris });
    return {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  async beginAuthorization(input: {
    clientId: string;
    redirectUri: string;
    responseType: string;
    state?: string;
    scope?: string;
    resource?: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  }) {
    if (input.responseType !== 'code') {
      throw new AppError('Only response_type=code is supported', 400, 'MCP_UNSUPPORTED_RESPONSE_TYPE');
    }
    if (input.codeChallengeMethod !== 'S256' || !input.codeChallenge) {
      throw new AppError('PKCE S256 is required', 400, 'MCP_PKCE_REQUIRED');
    }
    const resource = input.resource ?? mcpResource();
    if (resource !== mcpResource()) {
      throw new AppError('OAuth resource does not match the Stride MCP resource', 400, 'MCP_INVALID_RESOURCE');
    }
    const client = await this.resolveClient(input.clientId);
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new AppError('redirect_uri is not registered for this MCP client', 400, 'MCP_INVALID_REDIRECT_URI');
    }
    const scopes = parseScopes(input.scope);
    const request = await this.repository.createAuthorizationRequest({
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: input.redirectUri,
      state: input.state ?? null,
      scopes,
      resource,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(Date.now() + MCP_AUTHORIZATION_REQUEST_TTL_MS),
    });
    const consentUrl = new URL('/auth/mcp/authorize', `${env.FRONTEND_URL}/`);
    consentUrl.searchParams.set('request_id', request.id);
    return consentUrl.toString();
  }

  async authorizationRequest(userId: string, requestId: string) {
    const request = await this.requirePendingRequest(requestId);
    const stores = await this.repository.listUserStores(userId);
    return {
      id: request.id,
      client: { id: request.clientId, name: request.clientName },
      scopes: request.scopes,
      stores: stores.map((membership) => ({ ...membership.store, role: membership.role })),
      expiresAt: request.expiresAt,
    };
  }

  async approve(userId: string, requestId: string, storeId: string) {
    const request = await this.requirePendingRequest(requestId);
    if (!(await this.repository.hasStoreAccess(userId, storeId))) {
      throw new AppError('You do not have access to that store', 403, 'MCP_STORE_FORBIDDEN');
    }
    const code = opaqueToken(32);
    await this.repository.createAuthorizationCode({
      codeHash: tokenHash(code),
      userId,
      storeId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      resource: request.resource,
      codeChallenge: request.codeChallenge,
      expiresAt: new Date(Date.now() + MCP_AUTHORIZATION_CODE_TTL_MS),
    });
    await this.repository.deleteAuthorizationRequest(request.id);
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', mcpIssuer());
    return redirect.toString();
  }

  async deny(userId: string, requestId: string) {
    const request = await this.requirePendingRequest(requestId);
    // Reading the request through an authenticated endpoint proves the user is signed in; no store
    // access is needed to decline it.
    void userId;
    await this.repository.deleteAuthorizationRequest(request.id);
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', 'The merchant declined Stride MCP access.');
    if (request.state) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', mcpIssuer());
    return redirect.toString();
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource?: string;
  }) {
    const code = await this.repository.consumeAuthorizationCode(tokenHash(input.code));
    if (
      !code ||
      code.clientId !== input.clientId ||
      code.redirectUri !== input.redirectUri ||
      code.resource !== (input.resource ?? mcpResource()) ||
      pkceChallenge(input.codeVerifier) !== code.codeChallenge
    ) {
      throw new AppError('Invalid or expired authorization code', 400, 'MCP_INVALID_GRANT');
    }
    return this.issueTokens({
      userId: code.userId,
      storeId: code.storeId,
      clientId: code.clientId,
      scopes: code.scopes,
      resource: code.resource,
    });
  }

  async refresh(input: { refreshToken: string; clientId: string; resource?: string }) {
    const current = await this.repository.findRefreshToken(tokenHash(input.refreshToken));
    const resource = input.resource ?? mcpResource();
    if (
      !current ||
      current.revokedAt ||
      current.expiresAt <= new Date() ||
      current.clientId !== input.clientId ||
      current.resource !== resource
    ) {
      throw new AppError('Invalid or expired refresh token', 400, 'MCP_INVALID_GRANT');
    }
    const replacement = opaqueToken();
    const rotated = await this.repository.rotateRefreshToken({
      currentId: current.id,
      tokenHash: tokenHash(replacement),
      userId: current.userId,
      storeId: current.storeId,
      clientId: current.clientId,
      scopes: current.scopes,
      resource: current.resource,
      expiresAt: new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_MS),
    });
    if (!rotated) throw new AppError('Refresh token was already used', 400, 'MCP_INVALID_GRANT');
    const accessToken = await issueMcpAccessToken(current);
    return this.tokenResponse(accessToken, replacement, current.scopes);
  }

  private async issueTokens(input: {
    userId: string;
    storeId: string;
    clientId: string;
    scopes: string[];
    resource: string;
  }) {
    const accessToken = await issueMcpAccessToken(input);
    let refreshToken: string | undefined;
    if (input.scopes.includes(MCP_OFFLINE_SCOPE)) {
      refreshToken = opaqueToken();
      await this.repository.createRefreshToken({
        tokenHash: tokenHash(refreshToken),
        ...input,
        expiresAt: new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_MS),
      });
    }
    return this.tokenResponse(accessToken, refreshToken, input.scopes);
  }

  private tokenResponse(accessToken: string, refreshToken: string | undefined, scopes: string[]) {
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenExpiresIn(),
      scope: scopes.join(' '),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  private async requirePendingRequest(id: string) {
    const request = await this.repository.getAuthorizationRequest(id);
    if (!request || request.expiresAt <= new Date()) {
      if (request) await this.repository.deleteAuthorizationRequest(id);
      throw new AppError('MCP authorization request expired', 400, 'MCP_AUTH_REQUEST_EXPIRED');
    }
    return request;
  }

  private async resolveClient(clientId: string): Promise<ClientMetadata> {
    const registered = await this.repository.findRegisteredClient(clientId);
    if (registered) {
      return {
        clientId: registered.clientId,
        clientName: registered.clientName,
        redirectUris: registered.redirectUris,
      };
    }

    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new AppError('Unknown MCP client_id', 400, 'MCP_INVALID_CLIENT');
    }
    await assertSafeMetadataUrl(url);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new AppError('Unable to load MCP client metadata', 400, 'MCP_INVALID_CLIENT');
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > 64 * 1024) {
      throw new AppError('MCP client metadata is too large', 400, 'MCP_INVALID_CLIENT');
    }
    const metadata = (await response.json()) as Record<string, unknown>;
    if (metadata.client_id !== clientId || !Array.isArray(metadata.redirect_uris)) {
      throw new AppError('Invalid MCP client metadata document', 400, 'MCP_INVALID_CLIENT');
    }
    const redirectUris = metadata.redirect_uris.filter((value): value is string => typeof value === 'string');
    if (redirectUris.length === 0 || redirectUris.length !== metadata.redirect_uris.length) {
      throw new AppError('Invalid MCP redirect metadata', 400, 'MCP_INVALID_CLIENT');
    }
    for (const redirectUri of redirectUris) this.validateRedirectUri(redirectUri);
    return {
      clientId,
      clientName: typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 120) : url.hostname,
      redirectUris,
    };
  }

  private validateRedirectUri(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AppError('Invalid MCP redirect URI', 400, 'MCP_INVALID_REDIRECT_URI');
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !loopback) {
      throw new AppError('MCP redirect URI must use HTTPS or loopback', 400, 'MCP_INVALID_REDIRECT_URI');
    }
    if (url.username || url.password || url.hash) {
      throw new AppError('Invalid MCP redirect URI', 400, 'MCP_INVALID_REDIRECT_URI');
    }
  }
}

export const mcpOAuthService = new McpOAuthService();
