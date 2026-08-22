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
  verifyShopifyOAuthContext,
} from '../shopify.utils.js';
import type { ShopifyApiService } from './shopify-api.service.js';

const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

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
    // State is self-verifying so OAuth works even when frontend/backend are on separate
    // domains and the browser blocks the compatibility cookie set by the install XHR.
    const context = verifyShopifyOAuthContext(input.state);

    if (context.shop !== shop) {
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
    if (
      !connection.accessTokenExpiresAt ||
      connection.accessTokenExpiresAt.getTime() > Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS
    ) {
      return this.decryptCredential(connection.accessTokenCiphertext);
    }

    if (
      !connection.refreshTokenCiphertext ||
      !connection.refreshTokenExpiresAt ||
      connection.refreshTokenExpiresAt.getTime() <= Date.now()
    ) {
      await this.repository.markConnectionReauthRequired(connection.id).catch(() => undefined);
      throw new AppError(
        'Shopify offline credential has expired and must be reauthorized',
        409,
        'SHOPIFY_REAUTH_REQUIRED',
      );
    }

    const refreshToken = this.decryptCredential(connection.refreshTokenCiphertext);
    let refreshed: ShopifyAccessTokenResponse;
    try {
      refreshed = await this.refreshAccessToken(shop, refreshToken);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SHOPIFY_REAUTH_REQUIRED') {
        await this.repository.markConnectionReauthRequired(connection.id).catch(() => undefined);
      }
      throw error;
    }

    const tokenSet = this.toPlainTokenSet(refreshed);
    await this.repository.updateConnectionTokens(connection.id, this.encryptTokenSet(tokenSet));
    return tokenSet.accessToken;
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
      throw new AppError('Could not reach Shopify token endpoint', 502, 'SHOPIFY_UNAVAILABLE');
    }

    if (response.status >= 500) {
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

  private async parseJsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AppError('Shopify returned an invalid JSON response', 502, 'SHOPIFY_BAD_RESPONSE');
    }
  }
}
