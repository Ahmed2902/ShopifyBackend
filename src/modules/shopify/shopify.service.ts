import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { decryptSecret, encryptSecret } from '../integrations/integration.utils.js';
import type { IntegrationService } from '../integrations/integration.service.js';
import type { ShopifyRepository } from './shopify.repository.js';
import {
  shopifyAccessTokenSchema,
  shopifyGraphqlResponseSchema,
  shopifyInventoryLevelConnectionSchema,
  shopifyLocationConnectionSchema,
  shopifyProductConnectionSchema,
  shopifyProfileSchema,
  shopifyVariantConnectionSchema,
  type ShopifyAccessTokenResponse,
  type ShopifyShopProfile,
} from './shopify.schema.js';
import {
  buildShopifyAuthorizationUrl,
  calculateShopifyThrottleDelayMs,
  createShopifyOAuthContext,
  normalizeShopDomain,
  paginateShopifyConnection,
  parseRetryAfterMs,
  sleep,
  verifyShopifyOAuthContext,
} from './shopify.utils.js';

const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;
const SHOPIFY_REQUEST_ATTEMPTS = 3;
const SHOPIFY_PAGE_SIZE = 100;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const SHOP_QUERY = `#graphql
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

const PRODUCTS_QUERY = `#graphql
  query CatalogProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        handle
        productType
        vendor
        tags
        status
        totalInventory
        tracksInventory
        publishedAt
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query CatalogVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      nodes {
        id
        title
        displayName
        sku
        barcode
        price
        compareAtPrice
        position
        availableForSale
        inventoryQuantity
        inventoryPolicy
        createdAt
        updatedAt
        selectedOptions { name value }
        product { id }
        inventoryItem {
          id
          sku
          tracked
          requiresShipping
          createdAt
          updatedAt
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const LOCATIONS_QUERY = `#graphql
  query InventoryLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true, includeLegacy: true) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
        shipsInventory
        hasActiveInventory
        deactivatedAt
        address {
          address1
          address2
          city
          country
          countryCode
          province
          provinceCode
          zip
          phone
        }
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const LOCATION_INVENTORY_QUERY = `#graphql
  query LocationInventory($locationId: ID!, $first: Int!, $after: String) {
    location(id: $locationId) {
      inventoryLevels(first: $first, after: $after, includeInactive: true) {
        nodes {
          id
          updatedAt
          item { id }
          location { id }
          quantities(names: [
            "available"
            "incoming"
            "committed"
            "damaged"
            "on_hand"
            "quality_control"
            "reserved"
            "safety_stock"
          ]) { name quantity }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface ShopifyShopQueryData {
  shop: unknown;
}

interface ShopifyProductsQueryData {
  products: unknown;
}

interface ShopifyVariantsQueryData {
  productVariants: unknown;
}

interface ShopifyLocationsQueryData {
  locations: unknown;
}

interface ShopifyLocationInventoryQueryData {
  location: { inventoryLevels: unknown } | null;
}

interface PlainTokenSet {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  scopes: string[];
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

    const tokenResponse = await this.exchangeAuthorizationCode(shop, input.code);
    const tokenSet = this.toPlainTokenSet(tokenResponse);
    const profile = await this.fetchShopProfile(shop, tokenSet.accessToken, env.SHOPIFY_API_VERSION);
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

  async syncStoreData(storeId: string) {
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

    const accessToken = await this.resolveAccessToken(store.myshopifyDomain, connection);
    const syncRun = await this.integrationService.startSyncRun({
      provider: 'SHOPIFY',
      connectionId: connection.id,
      resourceType: 'CatalogInventory',
      mode: 'MANUAL',
      apiVersion: connection.apiVersion,
    });

    const breakdown = {
      shop: 0,
      products: 0,
      variants: 0,
      locations: 0,
      inventoryLevels: 0,
    };
    let recordsRead = 0;
    let recordsWritten = 0;

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

      const normalizedProfile: ShopifyShopProfile = { ...profile, myshopifyDomain: canonicalDomain };
      await this.repository.updateStoreProfile(storeId, normalizedProfile);
      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'Shop',
        externalId: normalizedProfile.id,
        apiVersion: connection.apiVersion,
        payload: normalizedProfile,
        syncRunId: syncRun.id,
      });
      breakdown.shop = 1;
      recordsRead += 1;
      recordsWritten += 1;

      const productStats = await this.syncProducts({
        storeId,
        shop: store.myshopifyDomain,
        accessToken,
        connectionId: connection.id,
        apiVersion: connection.apiVersion,
        syncRunId: syncRun.id,
      });
      breakdown.products = productStats.written;
      recordsRead += productStats.read;
      recordsWritten += productStats.written;

      const variantStats = await this.syncVariants({
        storeId,
        shop: store.myshopifyDomain,
        accessToken,
        connectionId: connection.id,
        apiVersion: connection.apiVersion,
        syncRunId: syncRun.id,
      });
      breakdown.variants = variantStats.written;
      recordsRead += variantStats.read;
      recordsWritten += variantStats.written;

      const locations = await this.syncLocations({
        storeId,
        shop: store.myshopifyDomain,
        accessToken,
        connectionId: connection.id,
        apiVersion: connection.apiVersion,
        syncRunId: syncRun.id,
      });
      breakdown.locations = locations.written;
      recordsRead += locations.read;
      recordsWritten += locations.written;

      const snapshotSource = connection.lastSyncedAt ? 'MANUAL_RECONCILIATION' : 'INITIAL_SYNC';
      for (const locationId of locations.ids) {
        const inventoryStats = await this.syncLocationInventory({
          storeId,
          shop: store.myshopifyDomain,
          locationId,
          accessToken,
          connectionId: connection.id,
          apiVersion: connection.apiVersion,
          syncRunId: syncRun.id,
          snapshotSource,
        });
        breakdown.inventoryLevels += inventoryStats.written;
        recordsRead += inventoryStats.read;
        recordsWritten += inventoryStats.written;
      }

      await this.repository.markConnectionSynced(connection.id);
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead, recordsWritten });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: 'CatalogInventory' as const,
        recordsRead,
        recordsWritten,
        breakdown,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  private async syncProducts(input: {
    storeId: string;
    shop: string;
    accessToken: string;
    connectionId: string;
    apiVersion: string;
    syncRunId: string;
  }) {
    let read = 0;
    let written = 0;

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.requestAdminGraphql<ShopifyProductsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: PRODUCTS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyProductConnectionSchema.safeParse(data.products);
      if (!connection.success) {
        throw new AppError('Shopify products query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      await this.recordPagePayload(input, 'ProductsPage', connection.data);
      return connection.data;
    });

    for await (const products of pages) {
      read += products.length;
      for (const product of products) {
        await this.repository.upsertProduct(input.storeId, product);
        written += 1;
      }
    }

    return { read, written };
  }

  private async syncVariants(input: {
    storeId: string;
    shop: string;
    accessToken: string;
    connectionId: string;
    apiVersion: string;
    syncRunId: string;
  }) {
    let read = 0;
    let written = 0;

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.requestAdminGraphql<ShopifyVariantsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: PRODUCT_VARIANTS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyVariantConnectionSchema.safeParse(data.productVariants);
      if (!connection.success) {
        throw new AppError('Shopify variants query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      await this.recordPagePayload(input, 'ProductVariantsPage', connection.data);
      return connection.data;
    });

    for await (const variants of pages) {
      read += variants.length;
      for (const variant of variants) {
        const persisted = await this.repository.upsertVariant(input.storeId, variant);
        if (!persisted) {
          throw new AppError(
            'Shopify variant references a product that was not synchronized',
            502,
            'SHOPIFY_CATALOG_INCONSISTENT',
          );
        }
        written += 1;
      }
    }

    return { read, written };
  }

  private async syncLocations(input: {
    storeId: string;
    shop: string;
    accessToken: string;
    connectionId: string;
    apiVersion: string;
    syncRunId: string;
  }): Promise<{ read: number; written: number; ids: string[] }> {
    let read = 0;
    let written = 0;
    const ids: string[] = [];

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.requestAdminGraphql<ShopifyLocationsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: LOCATIONS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyLocationConnectionSchema.safeParse(data.locations);
      if (!connection.success) {
        throw new AppError('Shopify locations query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      await this.recordPagePayload(input, 'LocationsPage', connection.data);
      return connection.data;
    });

    for await (const locations of pages) {
      read += locations.length;
      for (const location of locations) {
        await this.repository.upsertLocation(input.storeId, location);
        ids.push(location.id);
        written += 1;
      }
    }

    return { read, written, ids };
  }

  private async syncLocationInventory(input: {
    storeId: string;
    shop: string;
    locationId: string;
    accessToken: string;
    connectionId: string;
    apiVersion: string;
    syncRunId: string;
    snapshotSource: 'INITIAL_SYNC' | 'MANUAL_RECONCILIATION';
  }) {
    let read = 0;
    let written = 0;

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.requestAdminGraphql<ShopifyLocationInventoryQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: LOCATION_INVENTORY_QUERY,
        variables: {
          locationId: input.locationId,
          first: SHOPIFY_PAGE_SIZE,
          after: cursor,
        },
      });
      if (!data.location) {
        throw new AppError('Shopify location disappeared during sync', 502, 'SHOPIFY_CATALOG_INCONSISTENT');
      }
      const connection = shopifyInventoryLevelConnectionSchema.safeParse(data.location.inventoryLevels);
      if (!connection.success) {
        throw new AppError(
          'Shopify inventory query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      await this.recordPagePayload(input, 'InventoryLevelsPage', {
        locationId: input.locationId,
        ...connection.data,
      });
      return connection.data;
    });

    for await (const levels of pages) {
      read += levels.length;
      for (const level of levels) {
        this.assertInventoryQuantities(level.quantities.map((quantity) => quantity.name));
        const persisted = await this.repository.upsertInventoryLevel(
          input.storeId,
          level,
          input.snapshotSource,
        );
        if (!persisted) {
          throw new AppError(
            'Shopify inventory references catalog data that was not synchronized',
            502,
            'SHOPIFY_CATALOG_INCONSISTENT',
          );
        }
        written += 1;
      }
    }

    return { read, written };
  }

  private assertInventoryQuantities(names: string[]): void {
    const received = new Set(names);
    for (const required of [
      'available',
      'incoming',
      'committed',
      'damaged',
      'on_hand',
      'quality_control',
      'reserved',
      'safety_stock',
    ]) {
      if (!received.has(required)) {
        throw new AppError(
          `Shopify inventory response omitted ${required}`,
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
    }
  }

  private recordPagePayload(
    input: { apiVersion: string; syncRunId: string },
    resourceType: string,
    payload: unknown,
  ) {
    return this.integrationService.recordExternalPayload({
      provider: 'SHOPIFY',
      resourceType,
      apiVersion: input.apiVersion,
      payload,
      syncRunId: input.syncRunId,
    });
  }

  // region credentials
  private toPlainTokenSet(response: ShopifyAccessTokenResponse): PlainTokenSet {
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

  private encryptTokenSet(tokenSet: PlainTokenSet) {
    return {
      accessTokenCiphertext: encryptSecret(tokenSet.accessToken),
      accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
      refreshTokenCiphertext: encryptSecret(tokenSet.refreshToken),
      refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
      scopes: tokenSet.scopes,
    };
  }

  private async resolveAccessToken(
    shop: string,
    connection: {
      id: string;
      accessTokenCiphertext: string;
      accessTokenExpiresAt: Date | null;
      refreshTokenCiphertext: string | null;
      refreshTokenExpiresAt: Date | null;
      scopes: string[];
    },
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
  // endregion

  // region Shopify HTTP calls
  private async parseJsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AppError('Shopify returned an invalid JSON response', 502, 'SHOPIFY_BAD_RESPONSE');
    }
  }

  private async fetchShopProfile(
    shop: string,
    accessToken: string,
    apiVersion: string,
    connectionId?: string,
  ): Promise<ShopifyShopProfile> {
    const data = await this.requestAdminGraphql<ShopifyShopQueryData>({
      shop,
      accessToken,
      apiVersion,
      query: SHOP_QUERY,
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
