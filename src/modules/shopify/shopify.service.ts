import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { encryptSecret } from '../integrations/integration.utils.js';
import type { ShopifyRepository } from './shopify.repository.js';
import {
  shopifyAccessTokenSchema,
  shopifyProfileResponseSchema,
  type ShopifyShopProfile,
} from './shopify.schema.js';
import {
  buildShopifyAuthorizationUrl,
  createShopifyOAuthContext,
  normalizeShopDomain,
  verifyShopifyOAuthContext,
} from './shopify.utils.js';

export class ShopifyService {
  constructor(private readonly repository: ShopifyRepository) {}

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
    const profile = await this.fetchShopProfile(shop, token.accessToken);
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
        signal: AbortSignal.timeout(10_000),
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
      scopes: parsed.data.scope.split(',').map((scope) => scope.trim()).filter(Boolean),
    };
  }

  private async fetchShopProfile(shop: string, accessToken: string): Promise<ShopifyShopProfile> {
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

    let response: Response;
    try {
      response = await fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError('Could not reach Shopify Admin API', 502, 'SHOPIFY_UNAVAILABLE');
    }

    if (!response.ok) {
      throw new AppError('Shopify Admin API request failed', 502, 'SHOPIFY_API_FAILED');
    }

    const parsed = shopifyProfileResponseSchema.safeParse(await this.parseJsonResponse(response));
    if (!parsed.success || parsed.data.errors?.length || !parsed.data.data?.shop) {
      throw new AppError('Shopify shop query failed', 502, 'SHOPIFY_API_FAILED');
    }

    return parsed.data.data.shop;
  }
  // endregion
}
