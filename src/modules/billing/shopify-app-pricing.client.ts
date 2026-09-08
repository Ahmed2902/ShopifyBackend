import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

export type ShopifyAppPricingSubscription = {
  shop: {
    id: string;
    myshopifyDomain: string;
  };
  billingPeriod: string;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  currentBillingCycle: {
    startTime: string;
    endTime: string;
  } | null;
  items: Array<{
    handle: string | null;
    description: string | null;
    price: {
      __typename: string;
      active: boolean;
      currency: string;
      amount?: string;
    };
  }>;
  legacySubscriptionId: string | null;
};

type PartnerApiResponse = {
  data?: {
    activeSubscription: ShopifyAppPricingSubscription | null;
  };
  errors?: Array<{ message?: string; extensions?: { code?: string | number } }>;
};

const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      shop { id myshopifyDomain }
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle { startTime endTime }
      items {
        handle
        description
        price {
          __typename
          active
          currency
          ... on FlatRatePrice { amount }
        }
      }
      legacySubscriptionId
    }
  }
`;

function requiredConfig() {
  const values = {
    organizationId: env.SHOPIFY_PARTNER_ORG_ID,
    accessToken: env.SHOPIFY_PARTNER_API_ACCESS_TOKEN,
    appId: env.SHOPIFY_PARTNER_APP_ID,
    appHandle: env.SHOPIFY_APP_HANDLE,
    essentialsPlanHandle: env.SHOPIFY_ESSENTIALS_PLAN_HANDLE,
    proPlanHandle: env.SHOPIFY_PRO_PLAN_HANDLE,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new AppError(
      'Shopify App Pricing is enabled but its Partner API configuration is incomplete.',
      503,
      'SHOPIFY_APP_PRICING_NOT_CONFIGURED',
      { missing },
    );
  }
  return values as Record<keyof typeof values, string>;
}

function storeHandle(myshopifyDomain: string) {
  const suffix = '.myshopify.com';
  const normalized = myshopifyDomain.trim().toLowerCase();
  if (!normalized.endsWith(suffix)) {
    throw new AppError('Store domain is not a valid myshopify.com domain.', 400, 'INVALID_SHOPIFY_DOMAIN');
  }
  return normalized.slice(0, -suffix.length);
}

export class ShopifyAppPricingClient {
  isEnabled() {
    return env.SHOPIFY_APP_PRICING_ENABLED;
  }

  planHandles() {
    const config = requiredConfig();
    return {
      ESSENTIALS: config.essentialsPlanHandle,
      PRO: config.proPlanHandle,
    } as const;
  }

  planSelectionUrl(myshopifyDomain: string) {
    const config = requiredConfig();
    return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle(myshopifyDomain))}/charges/${encodeURIComponent(config.appHandle)}/pricing_plans`;
  }

  async activeSubscription(shopId: string): Promise<ShopifyAppPricingSubscription | null> {
    const config = requiredConfig();
    const endpoint = `https://partners.shopify.com/${encodeURIComponent(config.organizationId)}/api/${env.SHOPIFY_PARTNER_API_VERSION}/graphql.json`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.accessToken,
        },
        body: JSON.stringify({
          query: ACTIVE_SUBSCRIPTION_QUERY,
          variables: { appId: config.appId, shopId },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new AppError(
        'Shopify billing status could not be verified right now.',
        503,
        'SHOPIFY_BILLING_UNAVAILABLE',
        { cause: error instanceof Error ? error.message : 'network_error' },
      );
    }

    let payload: PartnerApiResponse;
    try {
      payload = (await response.json()) as PartnerApiResponse;
    } catch {
      throw new AppError(
        'Shopify billing status returned an unreadable response.',
        503,
        'SHOPIFY_BILLING_UNAVAILABLE',
      );
    }

    if (!response.ok || payload.errors?.length) {
      const providerCode = payload.errors?.[0]?.extensions?.code;
      throw new AppError(
        'Shopify billing status could not be verified right now.',
        503,
        'SHOPIFY_BILLING_UNAVAILABLE',
        { providerCode: providerCode ? String(providerCode) : String(response.status) },
      );
    }

    return payload.data?.activeSubscription ?? null;
  }
}

export const shopifyAppPricingClient = new ShopifyAppPricingClient();
