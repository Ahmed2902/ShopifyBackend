import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { shopifyAccessTokenSchema, type ShopifyAccessTokenResponse } from '../shopify.schema.js';
import { normalizeShopDomain } from '../shopify.utils.js';
import {
  shopifyOnlineAccessTokenSchema,
  type ShopifyOnlineAccessTokenResponse,
} from './shopify-embedded.schema.js';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';
const ONLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:online-access-token';
const REQUEST_TIMEOUT_MS = 10_000;

export class ShopifyTokenExchangeService {
  exchangeOffline(shop: string, idToken: string): Promise<ShopifyAccessTokenResponse> {
    return this.exchange(shop, idToken, OFFLINE_TOKEN_TYPE, (payload) => {
      const parsed = shopifyAccessTokenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError(
          'Shopify offline token exchange returned an unexpected response',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      return parsed.data;
    });
  }

  exchangeOnline(shop: string, idToken: string): Promise<ShopifyOnlineAccessTokenResponse> {
    return this.exchange(shop, idToken, ONLINE_TOKEN_TYPE, (payload) => {
      const parsed = shopifyOnlineAccessTokenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError(
          'Shopify online token exchange returned an unexpected response',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      return parsed.data;
    });
  }

  private async exchange<T>(
    requestedShop: string,
    idToken: string,
    requestedTokenType: string,
    parse: (payload: unknown) => T,
  ): Promise<T> {
    const shop = normalizeShopDomain(requestedShop);
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: idToken,
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: requestedTokenType,
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      expiring: '1',
    });

    let response: Response;
    try {
      response = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AppError('Could not reach Shopify token endpoint', 502, 'SHOPIFY_UNAVAILABLE');
    }

    if (response.status >= 500) {
      throw new AppError('Shopify token endpoint is unavailable', 502, 'SHOPIFY_UNAVAILABLE');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError('Shopify returned invalid token JSON', 502, 'SHOPIFY_BAD_RESPONSE');
    }

    if (!response.ok) {
      throw new AppError(
        'Shopify rejected the embedded app session token exchange',
        response.status === 400 || response.status === 401 ? 401 : 502,
        response.status === 400 || response.status === 401
          ? 'SHOPIFY_SESSION_INVALID'
          : 'SHOPIFY_TOKEN_EXCHANGE_FAILED',
      );
    }

    return parse(payload);
  }
}

export const shopifyTokenExchangeService = new ShopifyTokenExchangeService();
