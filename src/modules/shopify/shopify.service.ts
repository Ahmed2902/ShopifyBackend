import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { decryptSecret, encryptSecret } from '../integrations/integration.utils.js';
import type { IntegrationService } from '../integrations/integration.service.js';
import type { ShopifyRepository } from './shopify.repository.js';
import {
  shopifyAccessTokenSchema,
  shopifyGraphqlResponseSchema,
  shopifyProfileSchema,
  type ShopifyShopProfile,
} from './shopify.schema.js';
import {
  buildShopifyAuthorizationUrl,
  calculateShopifyThrottleDelayMs,
  createShopifyOAuthContext,
  normalizeShopDomain,
  parseRetryAfterMs,
  sleep,
  verifyShopifyOAuthContext,
} from './shopify.utils.js';

const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;
const SHOPIFY_REQUEST_ATTEMPTS = 3;

interface ShopifyShopQueryData {
  shop: unknown;
}

export class ShopifyService {
  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
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

    const token = await this.exchangeAuthorizationCode(shop, input.code);
    const profile = await this.fetchShopProfile(shop, token.accessToken, env.SHOPIFY_API_VERSION);
    const canonicalDomain = normalizeShopDomain(profile.myshopifyDomain);

    if (canonicalDomain !== shop) {
      throw new AppError('Shopify returned a different shop identity', 401, 'SHOP_IDENTITY_MISMATCH');
    }

    const store = await this.repository.connectStore({
      userId: context.userId,
      profile,
      canonicalDomain,
      encryptedToken: encryptSecret(token.accessToken),
      scopes: token.scopes,
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

  async syncShopProfile(storeId: string) {
    const store = await this.repository.findConnectionForSync(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const connection = store.shopifyConnection;
    if (!connection) {
      throw new AppError('Shopify is not connected for this store', 409, 'SHOPIFY_NOT_CONNECTED');
    }
    if (connection.status !== 'ACTIVE') {
      throw new AppError(
        'Shopify connection requires merchant attention',
        409,
        'SHOPIFY_CONNECTION_INACTIVE',
      );
    }

    let accessToken: string;
    try {
      accessToken = decryptSecret(connection.accessTokenCiphertext);
    } catch {
      throw new AppError('Stored Shopify credential could not be decrypted', 500, 'SHOPIFY_CREDENTIAL_ERROR');
    }

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: 'Shop',
      mode: 'MANUAL',
      apiVersion: connection.apiVersion,
    });

    try {
      const profile = await this.fetchShopProfile(
        store.myshopifyDomain,
        accessToken,
        connection.apiVersion,
        connection.id,
      );
      const canonicalDomain = normalizeShopDomain(profile.myshopifyDomain);

      if (canonicalDomain !== store.myshopifyDomain) {
        throw new AppError('Shopify returned a different shop identity', 401, 'SHOP_IDENTITY_MISMATCH');
      }

      const normalizedProfile: ShopifyShopProfile = {
        ...profile,
        myshopifyDomain: canonicalDomain,
      };

      await this.repository.updateStoreProfile(storeId, normalizedProfile);
      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'Shop',
        externalId: normalizedProfile.id,
        apiVersion: connection.apiVersion,
        payload: normalizedProfile,
        syncRunId: syncRun.id,
      });
      await this.repository.markConnectionSynced(connection.id);
      await this.integrationService.completeSyncRun(syncRun.id, {
        recordsRead: 1,
        recordsWritten: 1,
      });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: 'Shop' as const,
        recordsRead: 1,
        recordsWritten: 1,
        shop: normalizedProfile,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  // region Shopify HTTP calls
  private async parseJsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AppError('Shopify returned an invalid JSON response', 502, 'SHOPIFY_BAD_RESPONSE');
    }
  }

  private async exchangeAuthorizationCode(shop: string, code: string): Promise<{
    accessToken: string;
    scopes: string[];
  }> {
    let response: Response;
    try {
      response = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: env.SHOPIFY_CLIENT_ID,
          client_secret: env.SHOPIFY_CLIENT_SECRET,
          code,
        }),
        signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AppError('Could not reach Shopify during token exchange', 502, 'SHOPIFY_UNAVAILABLE');
    }

    if (!response.ok) {
      throw new AppError('Shopify rejected the authorization code', 502, 'SHOPIFY_TOKEN_EXCHANGE_FAILED');
    }

    const parsed = shopifyAccessTokenSchema.safeParse(await this.parseJsonResponse(response));
    if (!parsed.success) {
      throw new AppError('Shopify token response had an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
    }

    return {
      accessToken: parsed.data.access_token,
      scopes: parsed.data.scope
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
    };
  }

  private async fetchShopProfile(
    shop: string,
    accessToken: string,
    apiVersion: string,
    connectionId?: string,
  ): Promise<ShopifyShopProfile> {
    const query = `#graphql
      query AppInstallationShop {
        shop {
          id
          name
          myshopifyDomain
          currencyCode
          ianaTimezone
          primaryDomain { host url }
          enabledPresentmentCurrencies
          createdAt
        }
      }
    `;

    const data = await this.requestAdminGraphql<ShopifyShopQueryData>({
      shop,
      accessToken,
      apiVersion,
      query,
      connectionId,
    });
    const parsed = shopifyProfileSchema.safeParse(data.shop);
    if (!parsed.success) {
      throw new AppError('Shopify shop query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
    }

    return parsed.data;
  }

  private async requestAdminGraphql<TData>(input: {
    shop: string;
    accessToken: string;
    apiVersion: string;
    query: string;
    variables?: Record<string, unknown>;
    connectionId?: string;
  }): Promise<TData> {
    const url = `https://${input.shop}/admin/api/${input.apiVersion}/graphql.json`;

    for (let attempt = 0; attempt < SHOPIFY_REQUEST_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': input.accessToken,
          },
          body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
          signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < SHOPIFY_REQUEST_ATTEMPTS - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new AppError('Could not reach Shopify Admin API', 502, 'SHOPIFY_UNAVAILABLE');
      }

      if (response.status === 401 || response.status === 403) {
        if (input.connectionId) {
          await this.repository.markConnectionReauthRequired(input.connectionId).catch(() => undefined);
        }
        throw new AppError(
          'Shopify rejected the stored credential',
          409,
          'SHOPIFY_REAUTH_REQUIRED',
        );
      }

      if (response.status === 429) {
        if (attempt < SHOPIFY_REQUEST_ATTEMPTS - 1) {
          await sleep(parseRetryAfterMs(response.headers.get('retry-after')) ?? 1_000);
          continue;
        }
        throw new AppError('Shopify rate limit was exceeded', 503, 'SHOPIFY_THROTTLED');
      }

      if (response.status >= 500) {
        if (attempt < SHOPIFY_REQUEST_ATTEMPTS - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new AppError('Shopify Admin API is unavailable', 502, 'SHOPIFY_UNAVAILABLE');
      }

      if (!response.ok) {
        throw new AppError('Shopify Admin API request failed', 502, 'SHOPIFY_API_FAILED');
      }

      const envelope = shopifyGraphqlResponseSchema.safeParse(await this.parseJsonResponse(response));
      if (!envelope.success) {
        throw new AppError('Shopify GraphQL response had an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }

      if (envelope.data.errors?.length) {
        const throttled = envelope.data.errors.some(
          (error) => error.extensions?.code === 'THROTTLED',
        );
        if (throttled && attempt < SHOPIFY_REQUEST_ATTEMPTS - 1) {
          await sleep(calculateShopifyThrottleDelayMs(envelope.data.extensions?.cost));
          continue;
        }

        throw new AppError(
          throttled ? 'Shopify rate limit was exceeded' : 'Shopify GraphQL request failed',
          throttled ? 503 : 502,
          throttled ? 'SHOPIFY_THROTTLED' : 'SHOPIFY_GRAPHQL_FAILED',
        );
      }

      if (envelope.data.data === undefined) {
        throw new AppError('Shopify GraphQL response did not include data', 502, 'SHOPIFY_BAD_RESPONSE');
      }

      return envelope.data.data as TData;
    }

    throw new AppError('Shopify Admin API request failed', 502, 'SHOPIFY_API_FAILED');
  }
  // endregion
}
