import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../../lib/store-decision-cache.js';
import { billingService, type BillingService } from '../../billing/billing.service.js';
import { encryptSecret } from '../../integrations/integration.utils.js';
import { ShopifyRepository } from '../shopify.repository.js';
import { ShopifyApiService } from '../shared/shopify-api.service.js';
import { normalizeShopDomain } from '../shopify.utils.js';
import {
  shopifyEmbeddedAuthRepository,
  type EmbeddedOfflineCredentials,
  type ShopifyEmbeddedAuthRepository,
} from './shopify-embedded-auth.repository.js';
import type { ShopifyOnlineAccessTokenResponse } from './shopify-embedded.schema.js';
import { verifyShopifyIdToken } from './shopify-id-token.js';
import {
  shopifyTokenExchangeService,
  type ShopifyTokenExchangeService,
} from './shopify-token-exchange.service.js';

export type ShopifyEmbeddedSession = {
  source: 'SHOPIFY';
  userId: string;
  storeId: string;
  shop: string;
  shopifyUserId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  storeAccess: Array<{ storeId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }>;
};

function offlineCredentials(input: {
  access_token: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}): EmbeddedOfflineCredentials {
  const now = Date.now();
  return {
    accessTokenCiphertext: encryptSecret(input.access_token),
    accessTokenExpiresAt: new Date(now + input.expires_in * 1000),
    refreshTokenCiphertext: encryptSecret(input.refresh_token),
    refreshTokenExpiresAt: new Date(now + input.refresh_token_expires_in * 1000),
    scopes: input.scope
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}

export class ShopifyEmbeddedAuthService {
  private readonly apiService: ShopifyApiService;

  constructor(
    private readonly repository: ShopifyEmbeddedAuthRepository = shopifyEmbeddedAuthRepository,
    private readonly tokenExchange: ShopifyTokenExchangeService = shopifyTokenExchangeService,
    private readonly billing: BillingService = billingService,
  ) {
    this.apiService = new ShopifyApiService(new ShopifyRepository());
  }

  async authenticate(
    idToken: string,
    options: { refreshIdentity?: boolean } = {},
  ): Promise<ShopifyEmbeddedSession> {
    const tokenContext = await verifyShopifyIdToken(idToken);
    const existingStore = await this.repository.findStoreByShop(tokenContext.shop);
    let online: ShopifyOnlineAccessTokenResponse | undefined;

    if (existingStore?.shopifyConnection?.status === 'ACTIVE') {
      if (options.refreshIdentity) {
        online = await this.tokenExchange.exchangeOnline(tokenContext.shop, idToken);
        this.assertSameShopifyUser(online, tokenContext.shopifyUserId);
        const refreshed = await this.repository.refreshIdentity(
          existingStore.id,
          tokenContext.shopifyUserId,
          online.associated_user,
        );
        if (refreshed) {
          await this.billing.ensureSubscription(existingStore.id);
          return this.session({
            storeId: existingStore.id,
            userId: refreshed.userId,
            role: refreshed.role,
            shop: tokenContext.shop,
            shopifyUserId: tokenContext.shopifyUserId,
          });
        }
      } else {
        const identity = await this.repository.findIdentity(
          existingStore.id,
          tokenContext.shopifyUserId,
        );
        if (identity) {
          await this.billing.ensureSubscription(existingStore.id);
          return this.session({
            storeId: existingStore.id,
            userId: identity.userId,
            role: identity.role,
            shop: tokenContext.shop,
            shopifyUserId: tokenContext.shopifyUserId,
          });
        }
      }
    }

    // New install/reinstall or the first time this Shopify staff member opens Stride. The offline
    // token belongs to the shop and powers background work; the online token is used only to map
    // this authenticated Shopify staff identity into Stride's existing membership boundary.
    const offline = await this.tokenExchange.exchangeOffline(tokenContext.shop, idToken);
    online ??= await this.tokenExchange.exchangeOnline(tokenContext.shop, idToken);
    this.assertSameShopifyUser(online, tokenContext.shopifyUserId);

    const profile = await this.apiService.fetchShopProfile(
      tokenContext.shop,
      offline.access_token,
      env.SHOPIFY_API_VERSION,
    );
    const canonicalShop = normalizeShopDomain(profile.myshopifyDomain);
    if (canonicalShop !== tokenContext.shop) {
      throw new AppError(
        'Shopify returned a different shop identity during token exchange',
        401,
        'SHOP_IDENTITY_MISMATCH',
      );
    }

    const provisioned = await this.repository.provision({
      shop: canonicalShop,
      shopifyUserId: tokenContext.shopifyUserId,
      profile,
      associatedUser: online.associated_user,
      apiVersion: env.SHOPIFY_API_VERSION,
      credentials: offlineCredentials(offline),
    });

    await invalidateStoreDecisionCaches(provisioned.storeId);
    await this.billing.ensureSubscription(provisioned.storeId);

    return this.session({
      ...provisioned,
      shop: canonicalShop,
      shopifyUserId: tokenContext.shopifyUserId,
    });
  }

  private assertSameShopifyUser(
    online: ShopifyOnlineAccessTokenResponse,
    shopifyUserId: string,
  ) {
    if (String(online.associated_user.id) !== shopifyUserId) {
      throw new AppError(
        'Shopify returned a different staff identity during token exchange',
        401,
        'SHOPIFY_USER_IDENTITY_MISMATCH',
      );
    }
  }

  private session(input: {
    storeId: string;
    userId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    shop: string;
    shopifyUserId: string;
  }): ShopifyEmbeddedSession {
    return {
      source: 'SHOPIFY',
      userId: input.userId,
      storeId: input.storeId,
      shop: input.shop,
      shopifyUserId: input.shopifyUserId,
      role: input.role,
      storeAccess: [{ storeId: input.storeId, role: input.role }],
    };
  }
}

export const shopifyEmbeddedAuthService = new ShopifyEmbeddedAuthService();
