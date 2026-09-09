import { AppError } from '../../../errors/app-error.js';
import type { ShopifyRepository } from '../shopify.repository.js';
import { SHOP_QUERY } from '../shopify.queries.js';
import { shopifyGraphqlResponseSchema, shopifyProfileSchema } from '../shopify.schema.js';
import type { ShopifyShopProfile } from '../shopify.schema.js';
import type { ShopifyShopQueryData } from '../shopify.types.js';
import {
  calculateShopifyThrottleDelayMs,
  parseRetryAfterMs,
  sleep,
} from '../shopify.utils.js';

const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;
const SHOPIFY_REQUEST_ATTEMPTS = 3;
const MAX_PROVIDER_ERROR_MESSAGE = 500;
const UNIT_COST_SELECTION = /\s+unitCost\s*\{\s*amount\s+currencyCode\s*\}/m;

type ProviderGraphqlError = { message: string; extensions?: { code?: string } };

function providerErrors(errors: ProviderGraphqlError[]) {
  return errors.slice(0, 5).map((error) => ({
    code: error.extensions?.code ?? null,
    // Shopify GraphQL errors are useful for permission/schema diagnosis, but keep the public
    // payload bounded and never echo the query, variables, token or response envelope.
    message: error.message.slice(0, MAX_PROVIDER_ERROR_MESSAGE),
  }));
}

function unitCostAccessDenied(errors: ProviderGraphqlError[], query: string) {
  if (!UNIT_COST_SELECTION.test(query)) return false;
  return errors.some((error) => {
    const accessDenied = error.extensions?.code === 'ACCESS_DENIED' || /access denied/i.test(error.message);
    return accessDenied && /unit\s*cost|unitCost|product costs?/i.test(error.message);
  });
}

function removeUnitCostSelection(query: string) {
  return query.replace(UNIT_COST_SELECTION, '');
}

export class ShopifyApiService {
  constructor(private readonly repository: ShopifyRepository) {}

  async fetchShopProfile(
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

  async requestAdminGraphql<TData>(input: {
    shop: string;
    accessToken: string;
    apiVersion: string;
    query: string;
    variables?: Record<string, unknown>;
    connectionId?: string;
  }): Promise<TData> {
    const url = `https://${input.shop}/admin/api/${input.apiVersion}/graphql.json`;
    let query = input.query;
    let costFallbackUsed = false;

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
          body: JSON.stringify({ query, variables: input.variables ?? {} }),
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
        const rawErrors = envelope.data.errors;
        const throttled = rawErrors.some((error) => error.extensions?.code === 'THROTTLED');
        if (throttled && attempt < SHOPIFY_REQUEST_ATTEMPTS - 1) {
          await sleep(calculateShopifyThrottleDelayMs(envelope.data.extensions?.cost));
          continue;
        }

        // unitCost is useful for contribution-profit coverage, but Shopify can deny that single
        // field when the installing merchant lacks product-cost permission. It must not prevent
        // products, variants and inventory from syncing. Retry the same query without that
        // optional field; cost coverage then correctly remains incomplete instead of the whole
        // integration failing. Reset the transient-attempt budget because discovering the
        // deterministic field denial can itself happen after earlier timeout/throttle retries.
        if (!costFallbackUsed && unitCostAccessDenied(rawErrors, query)) {
          query = removeUnitCostSelection(query);
          costFallbackUsed = true;
          attempt = -1;
          continue;
        }

        const errors = providerErrors(rawErrors);
        const first = errors[0];
        throw new AppError(
          throttled
            ? 'Shopify rate limit was exceeded'
            : first?.message
              ? `Shopify GraphQL request failed: ${first.message}`
              : 'Shopify GraphQL request failed',
          throttled ? 503 : 502,
          throttled ? 'SHOPIFY_THROTTLED' : 'SHOPIFY_GRAPHQL_FAILED',
          { providerErrors: errors },
        );
      }

      if (envelope.data.data === undefined) {
        throw new AppError('Shopify GraphQL response did not include data', 502, 'SHOPIFY_BAD_RESPONSE');
      }

      return envelope.data.data as TData;
    }

    throw new AppError('Shopify Admin API request failed', 502, 'SHOPIFY_API_FAILED');
  }

  private async parseJsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AppError('Shopify returned an invalid JSON response', 502, 'SHOPIFY_BAD_RESPONSE');
    }
  }
}
