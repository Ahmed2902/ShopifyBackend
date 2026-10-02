import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const requiredScopes = ['read_products', 'read_inventory', 'read_locations',
  'read_orders', 'read_pixels', 'write_pixels', 'read_customer_events'];
export function renderShopifyAppConfig(input = process.env) {
  const required = (key) => {
    const value = input[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const publicUrl = (key) => {
    const url = new URL(required(key));
    if (url.protocol !== 'https:' || url.username || url.password ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error(`${key} must be a public HTTPS URL without credentials`);
    }
    return url;
  };
  const frontend = publicUrl('FRONTEND_URL');
  const application = publicUrl('SHOPIFY_APP_URL');
  const backend = publicUrl('APP_URL');
  const callback = publicUrl('SHOPIFY_REDIRECT_URI');
  if (application.origin !== frontend.origin || !/^\/app(?:\/|$)/.test(application.pathname)) {
    throw new Error('SHOPIFY_APP_URL must point to /app on FRONTEND_URL, not the marketing website');
  }
  if (callback.origin !== frontend.origin || callback.pathname !== '/api/shopify/callback') {
    throw new Error('SHOPIFY_REDIRECT_URI must point to FRONTEND_URL/api/shopify/callback');
  }
  const scopes = required('SHOPIFY_SCOPES').split(',').map((value) => value.trim()).filter(Boolean);
  for (const scope of requiredScopes) if (!scopes.includes(scope)) throw new Error(`Missing Shopify scope: ${scope}`);
  const allowed = new Set([...requiredScopes, 'write_products', 'read_all_orders']);
  for (const scope of scopes) if (!allowed.has(scope)) throw new Error(`Unjustified Shopify scope: ${scope}`);
  const quote = (value) => JSON.stringify(value);
  return `# Generated locally from public deployment configuration; contains no access tokens.\n` +
    `client_id = ${quote(required('SHOPIFY_CLIENT_ID'))}\nname = "Stride"\n` +
    `application_url = ${quote(application.toString())}\nembedded = true\n` +
    `[build]\nautomatically_update_urls_on_dev = false\ninclude_config_on_deploy = true\n` +
    `[access_scopes]\nscopes = ${quote([...new Set(scopes)].join(','))}\nuse_legacy_install_flow = false\n` +
    `[auth]\nredirect_urls = [${quote(callback.toString())}]\n` +
    `[webhooks]\napi_version = ${quote(input.SHOPIFY_API_VERSION ?? '2026-07')}\n` +
    `[[webhooks.subscriptions]]\ntopics = ["app/uninstalled", "app/scopes_update", "products/create", "products/update", "products/delete", "inventory_levels/update", "inventory_levels/connect", "inventory_levels/disconnect", "locations/create", "locations/update", "locations/activate", "locations/deactivate", "locations/delete", "orders/create", "orders/updated", "orders/delete", "refunds/create", "bulk_operations/finish"]\n` +
    `uri = ${quote(new URL('/v1/integrations/shopify/webhooks', backend).toString())}\n` +
    `[[webhooks.subscriptions]]\ncompliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]\n` +
    `uri = ${quote(new URL('/v1/integrations/shopify/webhooks', backend).toString())}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = renderShopifyAppConfig();
    await writeFile(new URL('../shopify.app.toml', import.meta.url), config);
    console.log('Generated shopify.app.toml. Validate with Shopify CLI, then review before deploying.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
