import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { decryptSecret, encryptSecret } from '../../integrations/integration.utils.js';
import type { ShopifyRepository } from '../shopify.repository.js';
import { shopifyAccessTokenSchema } from '../shopify.schema.js';
import type { ShopifyAccessTokenResponse } from '../shopify.schema.js';
import type {
  PlainShopifyTokenSet,
  ShopifyConnectionCredentialState,
} from '../shopify.types.js';
import {
  buildShopifyAuthorizationUrl,
  createShopifyOAuthContext,
  normalizeShopDomain,
  parseRetryAfterMs,
  sleep,
  verifyShopifyOAuthContext,
} from '../shopify.utils.js';
import type { ShopifyApiService } from './shopify-api.service.js';

const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;
const SHOPIFY_REFRESH_REQUEST_ATTEMPTS = 3;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_CLAIM_STALE_MS = 45_000;
const REFRESH_WAIT_TIMEOUT_MS = 50_000;
const REFRESH_WAIT_POLL_MS = 100;

export class ShopifyAuthService {
  constructor(
    private readonly repository: ShopifyRepository,
    private readonly apiService: ShopifyApiService,
  ) {}

  beginOAuth(userId: string, requestedShop: string) {
    const shop = normalizeShopDomain(requestedShop);
    const { state, cookieValue } = createShopifyOAuthContext(userId, shop);

    return {
      shop,
      cookieValue,
      authorizationUrl: buildShopifyAuthorizationUrl(shop, state),
    };
  }

  async completeOAuth(input: {
    code: string;
    shop: string;
    state: string;
    oauthContextCookie: string | undefined;
  }): Promise<{ storeId: string; shop: string }> {
    const shop = normalizeShopDomain(input.shop);
    const context = verifyShopifyOAuthContext(input.oauthContextCookie);

    if (context.state !== input.state || context.shop !== shop) {
      throw new AppError('Shopify OAuth state does not match', 401, 'INVALID_OAUTH_STATE');
    }

    const tokenResponse = await this.exchangeAuthorizationCode(shop, input.code);
    const tokenSet = this.toPlainTokenSet(tokenResponse);
    const profile = await this.apiService.fetchShopProfile(
      shop,
      tokenSet.accessToken,
      env.SHOPIFY_API_VERSION,
    );
    const canonicalDomain = normalizeShopDomain(profile.myshopifyDomain);

    if (canonicalDomain !== shop) {
      throw new AppError('Shopify returned a different shop identity', 401, 'SHOP_IDENTITY_MISMATCH');
    }

    const store = await this.repository.connectStore({
      userId: context.userId,
      profile,
      canonicalDomain,
      credentials: this.encryptTokenSet(tokenSet),
      apiVersion: env.SHOPIFY_API_VERSION,
    });

    if (!store) {
      throw new AppError(
        'This Shopify store is already connected to another account',
        409,
        'STORE_ALREADY_CONNECTED',
      );
    }

    return { storeId: store.id, shop: canonicalDomain };
  }

  async resolveAccessToken(
    shop: string,
    connection: ShopifyConnectionCredentialState,
  ): Promise<string> {
    if (this.accessTokenIsUsable(connection)) {
      return this.decryptCredential(connection.accessTokenCiphertext);
    }

    return this.refreshOrWait(shop, connection);
  }

  private accessTokenIsUsable(connection: ShopifyConnectionCredentialState): boolean {
    return (
      !connection.accessTokenExpiresAt ||
      connection.accessTokenExpiresAt.getTime() > Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS
    );
  }

  private refreshTokenIsUsable(connection: ShopifyConnectionCredentialState): boolean {
    return Boolean(
      connection.refreshTokenCiphertext &&
        connection.refreshTokenExpiresAt &&
        connection.refreshTokenExpiresAt.getTime() > Date.now(),
    );
  }

  private async refreshOrWait(
    shop: string,
    connection: ShopifyConnectionCredentialState,
  ): Promise<string> {
    if (!this.refreshTokenIsUsable(connection)) {
      return this.resolveInvalidRefreshState(shop, connection);
    }

    const refreshTokenCiphertext = connection.refreshTokenCiphertext!;
    const claimedAt = new Date();
    const staleBefore = new Date(claimedAt.getTime() - REFRESH_CLAIM_STALE_MS);
    const claimed = await this.repository.tryClaimTokenRefresh(
      connection.id,
      refreshTokenCiphertext,
      claimedAt,
      staleBefore,
    );

    if (!claimed) {
      return this.waitForConcurrentRefresh(shop, connection);
    }

    return this.performClaimedRefresh(shop, connection, refreshTokenCiphertext, claimedAt);
  }

  private async performClaimedRefresh(
    shop: string,
    connection: ShopifyConnectionCredentialState,
    refreshTokenCiphertext: string,
    claimedAt: Date,
  ): Promise<string> {
    const refreshToken = this.decryptCredential(refreshTokenCiphertext);
    let refreshed: ShopifyAccessTokenResponse;

    try {
      refreshed = await this.refreshAccessToken(shop, refreshToken);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SHOPIFY_REAUTH_REQUIRED') {
        const marked = await this.repository.markConnectionReauthRequiredIfRefreshTokenMatches(
          connection.id,
          refreshTokenCiphertext,
        );
        if (!marked) {
          const latest = await this.repository.getConnectionCredentialState(connection.id);
          if (latest?.status === 'ACTIVE') return this.resolveAccessToken(shop, latest);
        }
      } else {
        await this.repository.releaseTokenRefreshClaim(connection.id, claimedAt).catch(() => undefined);
      }
      throw error;
    }

    const tokenSet = this.toPlainTokenSet(refreshed);
    const persisted = await this.repository.completeTokenRefresh(
      connection.id,
      refreshTokenCiphertext,
      claimedAt,
      this.encryptTokenSet(tokenSet),
    );
    if (persisted) return tokenSet.accessToken;

    const latest = await this.repository.getConnectionCredentialState(connection.id);
    if (latest?.status === 'ACTIVE' && this.accessTokenIsUsable(latest)) {
      return this.decryptCredential(latest.accessTokenCiphertext);
    }

    throw new AppError(
      'Shopify credential changed while token refresh was completing',
      503,
      'SHOPIFY_TOKEN_REFRESH_CONFLICT',
    );
  }

  private async waitForConcurrentRefresh(
    shop: string,
    original: ShopifyConnectionCredentialState,
  ): Promise<string> {
    const deadline = Date.now() + REFRESH_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(REFRESH_WAIT_POLL_MS);
      const latest = await this.repository.getConnectionCredentialState(original.id);
      if (!latest) {
        throw new AppError('Shopify connection no longer exists', 409, 'SHOPIFY_NOT_CONNECTED');
      }
      if (latest.status !== 'ACTIVE') {
        throw new AppError(
          'Shopify connection requires merchant attention',
          409,
          'SHOPIFY_REAUTH_REQUIRED',
        );
      }
      if (this.accessTokenIsUsable(latest)) {
        return this.decryptCredential(latest.accessTokenCiphertext);
      }

      const claimIsStale =
        !latest.refreshClaimedAt ||
        latest.refreshClaimedAt.getTime() <= Date.now() - REFRESH_CLAIM_STALE_MS;
      const refreshTokenChanged =
        latest.refreshTokenCiphertext !== original.refreshTokenCiphertext;

      if (refreshTokenChanged || claimIsStale) {
        return this.refreshOrWait(shop, latest);
      }
    }

    throw new AppError(
      'Timed out waiting for another worker to refresh the Shopify credential',
      503,
      'SHOPIFY_TOKEN_REFRESH_BUSY',
    );
  }

  private async resolveInvalidRefreshState(
    shop: string,
    original: ShopifyConnectionCredentialState,
  ): Promise<string> {
    const latest = await this.repository.getConnectionCredentialState(original.id);
    if (!latest) {
      throw new AppError('Shopify connection no longer exists', 409, 'SHOPIFY_NOT_CONNECTED');
    }
    if (latest.status !== 'ACTIVE') {
      throw new AppError(
        'Shopify connection requires merchant attention',
        409,
        'SHOPIFY_REAUTH_REQUIRED',
      );
    }
    if (this.accessTokenIsUsable(latest)) {
      return this.decryptCredential(latest.accessTokenCiphertext);
    }
    if (this.refreshTokenIsUsable(latest)) {
      return this.refreshOrWait(shop, latest);
    }

    if (latest.refreshTokenCiphertext) {
      await this.repository
        .markConnectionReauthRequiredIfRefreshTokenMatches(
          latest.id,
          latest.refreshTokenCiphertext,
        )
        .catch(() => undefined);
    } else {
      await this.repository.markConnectionReauthRequired(latest.id).catch(() => undefined);
    }

    throw new AppError(
      'Shopify offline credential has expired and must be reauthorized',
      409,
      'SHOPIFY_REAUTH_REQUIRED',
    );
  }

  private toPlainTokenSet(response: ShopifyAccessTokenResponse): PlainShopifyTokenSet {
    const now = Date.now();
    return {
      accessToken: response.access_token,
      accessTokenExpiresAt: new Date(now + response.expires_in * 1000),
      refreshToken: response.refresh_token,
      refreshTokenExpiresAt: new Date(now + response.refresh_token_expires_in * 1000),
      scopes: response.scope
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
    };
  }

  private encryptTokenSet(tokenSet: PlainShopifyTokenSet) {
    return {
      accessTokenCiphertext: encryptSecret(tokenSet.accessToken),
      accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
      refreshTokenCiphertext: encryptSecret(tokenSet.refreshToken),
      refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
      scopes: tokenSet.scopes,
    };
  }

  private decryptCredential(ciphertext: string): string {
    try {
      return decryptSecret(ciphertext);
    } catch {
      throw new AppError('Stored Shopify credential could not be decrypted', 500, 'SHOPIFY_CREDENTIAL_ERROR');
    }
  }

  private exchangeAuthorizationCode(shop: string, code: string) {
    return this.requestTokenEndpoint(
      shop,
      new URLSearchParams({
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        code,
        expiring: '1',
      }),
      false,
    );
  }

  private refreshAccessToken(shop: string, refreshToken: string) {
    return this.requestTokenEndpoint(
      shop,
      new URLSearchParams({
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      true,
    );
  }

  private async requestTokenEndpoint(
    shop: string,
    body: URLSearchParams,
    isRefresh: boolean,
  ): Promise<ShopifyAccessTokenResponse> {
    const attempts = isRefresh ? SHOPIFY_REFRESH_REQUEST_ATTEMPTS : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`https://${shop}/admin/oauth/access_token`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (isRefresh && attempt < attempts - 1) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new AppError('Could not reach Shopify token endpoint', 502, 'SHOPIFY_UNAVAILABLE');
      }

      if (response.status === 429) {
        if (isRefresh && attempt < attempts - 1) {
          await sleep(parseRetryAfterMs(response.headers.get('retry-after')) ?? 500 * 2 ** attempt);
          continue;
        }
        throw new AppError(
          'Shopify token endpoint is temporarily rate limited',
          502,
          'SHOPIFY_UNAVAILABLE',
        );
      }
      if (response.status >= 500) {
        if (isRefresh && attempt < attempts - 1) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new AppError('Shopify token endpoint is unavailable', 502, 'SHOPIFY_UNAVAILABLE');
      }
      if (!response.ok) {
        throw new AppError(
          isRefresh ? 'Shopify refresh token was rejected' : 'Shopify rejected the authorization code',
          isRefresh ? 409 : 502,
          isRefresh ? 'SHOPIFY_REAUTH_REQUIRED' : 'SHOPIFY_TOKEN_EXCHANGE_FAILED',
        );
      }

      const parsed = shopifyAccessTokenSchema.safeParse(await this.parseJsonResponse(response));
      if (!parsed.success) {
        throw new AppError('Shopify token response had an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      return parsed.data;
    }

    throw new AppError('Shopify token endpoint is unavailable', 502, 'SHOPIFY_UNAVAILABLE');
  }

  private async parseJsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AppError('Shopify returned an invalid JSON response', 502, 'SHOPIFY_BAD_RESPONSE');
    }
  }
}
