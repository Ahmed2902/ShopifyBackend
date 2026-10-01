import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const failures = [];
const warnings = [];

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}`);
  return value;
}
function requireTrue(name) {
  if (process.env[name] !== 'true') fail(`${name} must be true for App Store submission`);
}
function requireEmail(name) {
  const value = requireEnv(name);
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(`${name} is not a valid email address`);
}
function requireHttpsUrl(name) {
  const value = requireEnv(name);
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') fail(`${name} must use https`);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(`${name} must use a public host`);
    if (url.username || url.password) fail(`${name} must not contain credentials`);
  } catch {
    fail(`${name} is not a valid URL`);
  }
}

requireTrue('SHOPIFY_APP_PRICING_ENABLED');
if (process.env.LEGACY_MERCHANT_AUTH_ENABLED === 'true') fail('Legacy merchant auth must be disabled for App Store submission');
[
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_PARTNER_ORG_ID',
  'SHOPIFY_PARTNER_API_ACCESS_TOKEN',
  'SHOPIFY_PARTNER_APP_ID',
  'SHOPIFY_APP_HANDLE',
  'SHOPIFY_ESSENTIALS_PLAN_HANDLE',
  'SHOPIFY_PRO_PLAN_HANDLE',
].forEach(requireEnv);
requireEmail('SHOPIFY_SUPPORT_EMAIL');
requireEmail('SHOPIFY_REVIEW_CONTACT_EMAIL');
requireEmail('SHOPIFY_EMERGENCY_CONTACT_EMAIL');
requireHttpsUrl('SHOPIFY_PRIVACY_POLICY_URL');
requireHttpsUrl('SHOPIFY_TERMS_URL');
requireHttpsUrl('SHOPIFY_APP_URL');
['APP_URL', 'FRONTEND_URL', 'CORS_ORIGIN', 'SHOPIFY_REDIRECT_URI', 'PIXEL_COLLECTOR_URL'].forEach(requireHttpsUrl);
try {
  if (process.env.SHOPIFY_APP_URL && process.env.FRONTEND_URL &&
      new URL(process.env.SHOPIFY_APP_URL).origin !== new URL(process.env.FRONTEND_URL).origin) {
    fail('SHOPIFY_APP_URL must point to the embedded frontend origin');
  }
} catch { /* Invalid URLs are reported above. */ }

const scopes = new Set((requireEnv('SHOPIFY_SCOPES') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
for (const required of ['read_products', 'read_inventory', 'read_locations', 'read_orders', 'write_pixels', 'read_customer_events']) {
  if (!scopes.has(required)) fail(`SHOPIFY_SCOPES is missing ${required}`);
}
if (scopes.has('read_customers')) {
  fail('SHOPIFY_SCOPES includes read_customers, but current Stride order analytics do not require the Customer resource');
}

const [privacySchema, orderQueries, apiService, authMiddleware, billingClient] = await Promise.all([
  readFile(new URL('../src/modules/shopify/privacy/shopify-privacy.schema.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/modules/shopify/order/shopify-order.queries.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/modules/shopify/shared/shopify-api.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/middleware/auth.middleware.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/modules/billing/shopify-app-pricing.client.ts', import.meta.url), 'utf8'),
]);

for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact']) {
  if (!privacySchema.includes(topic)) fail(`Mandatory Shopify privacy topic is missing: ${topic}`);
}
if (!apiService.includes('/graphql.json')) fail('Shopify Admin API client is not using GraphQL');
if (!authMiddleware.includes('shopifyEmbeddedAuthService')) fail('Embedded Shopify ID-token auth is not wired into requireAuth');
if (!billingClient.includes('activeSubscription')) fail('Shopify App Pricing Active Subscription verification is not wired');

const levelTwoFields = [
  /\bcustomer\s*\{/i,
  /\bemail\b/i,
  /\bphone\b/i,
  /\bshippingAddress\b/i,
  /\bbillingAddress\b/i,
  /\bfirstName\b/i,
  /\blastName\b/i,
];
for (const pattern of levelTwoFields) {
  if (pattern.test(orderQueries)) fail(`Order queries request a level-2 customer field matching ${pattern}`);
}

if (scopes.has('write_products')) {
  warn('write_products is enabled. Confirm collection-write functionality is included in the App Store listing and review instructions.');
}
warn('read_orders means Stride uses level-1 protected customer data. Request protected customer data access in Partner Dashboard and explain the analytics purpose; do not request level-2 fields.');
warn('This backend gate cannot verify the frontend App Bridge script, listing icon/screenshots, reviewer screencast, Partner Dashboard emergency contact, or the actual published privacy/support URLs. Validate those manually before submission.');

console.log('Shopify App Store readiness check');
for (const item of warnings) console.log(`WARN: ${item}`);
if (failures.length) {
  for (const item of failures) console.error(`FAIL: ${item}`);
  process.exitCode = 1;
} else {
  console.log('PASS: backend/config readiness checks passed. Complete the manual Partner Dashboard + frontend checklist before submission.');
}
