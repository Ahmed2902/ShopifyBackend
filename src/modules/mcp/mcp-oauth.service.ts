import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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

const MAX_CLIENT_METADATA_BYTES = 64 * 1024;
const MAX_CLIENT_REDIRECT_URIS = 20;

function normalizeIp(address: string) {
  const withoutBrackets = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = withoutBrackets.indexOf('%');
  return zoneIndex >= 0 ? withoutBrackets.slice(0, zoneIndex) : withoutBrackets;
}

function nonPublicIp(address: string): boolean {
  const normalized = normalizeIp(address);
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return nonPublicIp(mapped);
  }

  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [first, second, third] = parts as [number, number, number, number];
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('ff')) return true;
    if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return true;
    if (normalized.startsWith('64:ff9b:1:')) return true;
  }
  return false;
}

async function assertSafeMetadataUrl(url: URL) {
  if (url.protocol !== 'https:') {
    if (
      env.NODE_ENV !== 'production' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    ) {
      return;
    }
    throw new AppError('MCP client metadata URL must use HTTPS', 400, 'MCP_INVALID_CLIENT');
  }
  if (url.username || url.password || url.hash) {
    throw new AppError('Invalid MCP client metadata URL', 400, 'MCP_INVALID_CLIENT');
  }
  if (isIP(normalizeIp(url.hostname)) && nonPublicIp(url.hostname)) {
    throw new AppError(
      'Non-public MCP client metadata addresses are not allowed',
      400,
      'MCP_INVALID_CLIENT',
    );
  }
  try {
    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.length === 0 || addresses.some((entry) => nonPublicIp(entry.address))) {
      throw new AppError(
        'Non-public MCP client metadata addresses are not allowed',
        400,
        'MCP_INVALID_CLIENT',
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Unable to resolve MCP client metadata host', 400, 'MCP_INVALID_CLIENT');
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AppError('Empty MCP client metadata response', 400, 'MCP_INVALID_CLIENT');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_CLIENT_METADATA_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('MCP client metadata is too large', 400, 'MCP_INVALID_CLIENT');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError('Invalid MCP client metadata document', 400, 'MCP_INVALID_CLIENT');
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

  async registerClient(input: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
  }) {
    const redirectUris = input.redirect_uris ?? [];
    if (redirectUris.length === 0 || redirectUris.length > MAX_CLIENT_REDIRECT_URIS) {
      throw new AppError('redirect_uris is required', 400, 'MCP_INVALID_CLIENT_METADATA');
    }
    const unsupportedGrant = input.grant_types?.find(
      (grant) => grant !== 'authorization_code' && grant !== 'refresh_token',
    );
    if (unsupportedGrant) {
      throw new AppError(`Unsupported grant type: ${unsupportedGrant}`, 400, 'MCP_INVALID_CLIENT_METADATA');
    }
    const unsupportedResponse = input.response_types?.find((type) => type !== 'code');
    if (unsupportedResponse) {
      throw new AppError(
        `Unsupported response type: ${unsupportedResponse}`,
        400,
        'MCP_INVALID_CLIENT_METADATA',
      );
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
      throw new AppError(
        'OAuth resource does not match the Stride MCP resource',
        400,
        'MCP_INVALID_RESOURCE',
      );
    }
    const client = await this.resolveClient(input.clientId);
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new AppError(
        'redirect_uri is not registered for this MCP client',
        400,
        'MCP_INVALID_REDIRECT_URI',
      );
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
    const authorizationCode = await this.repository.claimAuthorizationRequestAndCreateCode({
      requestId: request.id,
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
    if (!authorizationCode) {
      throw new AppError(
        'Authorization request has already been used or expired',
        400,
        'MCP_AUTH_REQUEST_EXPIRED',
      );
    }
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', mcpIssuer());
    return redirect.toString();
  }

  async deny(userId: string, requestId: string) {
    const request = await this.requirePendingRequest(requestId);
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
    const codeHash = tokenHash(input.code);
    const candidate = await this.repository.findAuthorizationCode(codeHash);
    const resource = input.resource ?? mcpResource();
    if (
      !candidate ||
      candidate.usedAt ||
      candidate.expiresAt <= new Date() ||
      candidate.clientId !== input.clientId ||
      candidate.redirectUri !== input.redirectUri ||
      candidate.resource !== resource ||
      pkceChallenge(input.codeVerifier) !== candidate.codeChallenge
    ) {
      throw new AppError('Invalid or expired authorization code', 400, 'MCP_INVALID_GRANT');
    }
    if (!(await this.repository.hasStoreAccess(candidate.userId, candidate.storeId))) {
      throw new AppError('Authorization grant is no longer valid', 400, 'MCP_INVALID_GRANT');
    }

    // Claim only after all public-client bindings, PKCE, and current store membership have been
    // validated. The repository performs the one-time claim atomically, so concurrent replays can
    // validate the same candidate but only one can proceed to token issuance.
    const code = await this.repository.consumeAuthorizationCode(codeHash);
    if (!code) {
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
    if (!(await this.repository.hasStoreAccess(current.userId, current.storeId))) {
      throw new AppError('Authorization grant is no longer valid', 400, 'MCP_INVALID_GRANT');
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
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw new AppError('Unable to load MCP client metadata', 400, 'MCP_INVALID_CLIENT');
    }
    if (!response.ok) {
      throw new AppError('Unable to load MCP client metadata', 400, 'MCP_INVALID_CLIENT');
    }
    const advertisedLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_CLIENT_METADATA_BYTES) {
      throw new AppError('MCP client metadata is too large', 400, 'MCP_INVALID_CLIENT');
    }
    const metadata = await readBoundedJson(response);
    if (
      metadata.client_id !== clientId ||
      !Array.isArray(metadata.redirect_uris) ||
      metadata.redirect_uris.length === 0 ||
      metadata.redirect_uris.length > MAX_CLIENT_REDIRECT_URIS
    ) {
      throw new AppError('Invalid MCP client metadata document', 400, 'MCP_INVALID_CLIENT');
    }
    const redirectUris = metadata.redirect_uris.filter(
      (value): value is string => typeof value === 'string',
    );
    if (redirectUris.length !== metadata.redirect_uris.length) {
      throw new AppError('Invalid MCP redirect metadata', 400, 'MCP_INVALID_CLIENT');
    }
    for (const redirectUri of redirectUris) this.validateRedirectUri(redirectUri);
    return {
      clientId,
      clientName:
        typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 120) : url.hostname,
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
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !loopback) {
      throw new AppError(
        'MCP redirect URI must use HTTPS or loopback',
        400,
        'MCP_INVALID_REDIRECT_URI',
      );
    }
    if (url.username || url.password || url.hash) {
      throw new AppError('Invalid MCP redirect URI', 400, 'MCP_INVALID_REDIRECT_URI');
    }
  }
}

export const mcpOAuthService = new McpOAuthService();