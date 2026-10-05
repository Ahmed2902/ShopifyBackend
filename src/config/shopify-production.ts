type ShopifyProductionConfig = {
  SHOPIFY_APP_PRICING_ENABLED: boolean; LEGACY_MERCHANT_AUTH_ENABLED: boolean;
  SHOPIFY_PARTNER_ORG_ID?: string; SHOPIFY_PARTNER_API_ACCESS_TOKEN?: string;
  SHOPIFY_PARTNER_APP_ID?: string; SHOPIFY_APP_HANDLE?: string;
  SHOPIFY_ESSENTIALS_PLAN_HANDLE?: string; SHOPIFY_PRO_PLAN_HANDLE?: string;
  SHOPIFY_REDIRECT_URI: string; PIXEL_COLLECTOR_URL?: string;
};

export function assertShopifyProductionConfig(config: ShopifyProductionConfig, urls: string[]) {
  if (!config.SHOPIFY_APP_PRICING_ENABLED) {
    throw new Error('Production requires SHOPIFY_APP_PRICING_ENABLED=true; internal trials are development-only');
  }
  if (config.LEGACY_MERCHANT_AUTH_ENABLED) {
    throw new Error('Production requires LEGACY_MERCHANT_AUTH_ENABLED=false; merchant sign-in is through Shopify');
  }
  for (const key of ['SHOPIFY_PARTNER_ORG_ID', 'SHOPIFY_PARTNER_API_ACCESS_TOKEN',
    'SHOPIFY_PARTNER_APP_ID', 'SHOPIFY_APP_HANDLE', 'SHOPIFY_ESSENTIALS_PLAN_HANDLE',
    'SHOPIFY_PRO_PLAN_HANDLE'] as const) {
    if (!config[key]?.trim()) throw new Error(`Production Shopify App Pricing requires ${key}`);
  }
  if (config.SHOPIFY_ESSENTIALS_PLAN_HANDLE === config.SHOPIFY_PRO_PLAN_HANDLE) {
    throw new Error('Shopify Essentials and Pro plan handles must be distinct');
  }
  for (const value of [...urls, config.SHOPIFY_REDIRECT_URI,
    ...(config.PIXEL_COLLECTOR_URL ? [config.PIXEL_COLLECTOR_URL] : [])]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Production Shopify app URLs must use HTTPS and must not contain credentials');
    }
  }
}
