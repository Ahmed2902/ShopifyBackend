#!/usr/bin/env node

const baseUrl = requiredEnv('BASE_URL').replace(/\/$/, '');
const storeId = requiredEnv('STORE_ID');
const accessToken = requiredEnv('ACCESS_TOKEN');
const timeoutMs = numberEnv('SMOKE_TIMEOUT_MS', 15000);

const expectations = {
  shopifyBilling: booleanEnv('EXPECT_SHOPIFY_BILLING'),
  pixelActive: booleanEnv('EXPECT_PIXEL_ACTIVE'),
  metaConnected: booleanEnv('EXPECT_META_CONNECTED'),
  linkedPurchaseSession: booleanEnv('EXPECT_LINKED_PURCHASE_SESSION'),
  minimumMappingCoverage: optionalNumberEnv('EXPECT_MIN_MAPPING_COVERAGE'),
};

const options = {
  refreshBilling: booleanEnv('SMOKE_REFRESH_BILLING'),
  sendAuthEmail: booleanEnv('SMOKE_SEND_AUTH_EMAIL'),
  authTestEmail: process.env.AUTH_TEST_EMAIL?.trim() || null,
};

if (options.sendAuthEmail && !options.authTestEmail) {
  throw new Error('AUTH_TEST_EMAIL is required when SMOKE_SEND_AUTH_EMAIL=true');
}
if (
  expectations.minimumMappingCoverage !== null &&
  (expectations.minimumMappingCoverage < 0 || expectations.minimumMappingCoverage > 1)
) {
  throw new Error('EXPECT_MIN_MAPPING_COVERAGE must be between 0 and 1');
}

const results = [];

await check('API liveness', '/health/live', { auth: false });
await check('API readiness', '/health/ready', { auth: false });

const billing = options.refreshBilling
  ? await check('Billing provider refresh', `/v1/stores/${storeId}/billing/refresh`, {
      method: 'POST',
    })
  : await check('Billing state', `/v1/stores/${storeId}/billing`);
assert(billing.body?.accessActive === true, 'Billing access is not active');

const billingPortal = await check('Billing portal', `/v1/stores/${storeId}/billing/portal`);
if (expectations.shopifyBilling) {
  assert(
    billing.body?.provider === 'SHOPIFY',
    `Expected Shopify billing, received ${String(billing.body?.provider)}`,
  );
  assert(
    billing.body?.verification?.source === 'SHOPIFY_PARTNER_API',
    `Expected SHOPIFY_PARTNER_API verification, received ${String(billing.body?.verification?.source)}`,
  );
  assert(
    billingPortal.body?.mode === 'SHOPIFY_APP_PRICING',
    `Expected SHOPIFY_APP_PRICING portal, received ${String(billingPortal.body?.mode)}`,
  );
  assert(
    typeof billingPortal.body?.url === 'string' && billingPortal.body.url.length > 0,
    'Shopify pricing portal URL is missing',
  );
}

const pixelStatus = await check('Stride Pixel status', `/v1/stores/${storeId}/pixel/status`);
const pixelHealth = await check('Stride Pixel health', `/v1/stores/${storeId}/pixel/health`);
if (expectations.pixelActive) {
  assert(
    pixelStatus.body?.status === 'ACTIVE',
    `Expected ACTIVE Pixel, received ${String(pixelStatus.body?.status)}`,
  );
  assert(
    typeof pixelStatus.body?.shopifyWebPixelId === 'string' &&
      pixelStatus.body.shopifyWebPixelId.length > 0,
    'ACTIVE Pixel is missing shopifyWebPixelId',
  );
}

const pixelBehavior = await check(
  'Storefront behavior analytics',
  `/v1/stores/${storeId}/pixel/analytics/overview?days=30`,
);

const sessionQuery = expectations.linkedPurchaseSession
  ? '?page=1&limit=50&checkoutCompleted=true'
  : '?page=1&limit=20';
const pixelSessions = await check(
  'Pixel session evidence',
  `/v1/stores/${storeId}/pixel/sessions${sessionQuery}`,
);
assert(Array.isArray(pixelSessions.body?.items), 'Pixel sessions response is missing items[]');

if (expectations.linkedPurchaseSession) {
  const linked = pixelSessions.body.items.find(
    (session) =>
      session?.checkoutCompletedAt &&
      session?.orderLinkStatus === 'LINKED' &&
      session?.order &&
      session.order.isTest === false &&
      session.order.cancelledAt === null,
  );
  assert(
    linked,
    'No recent checkout-completed Pixel session is linked to a non-test, non-cancelled Shopify order',
  );
}

const attributionSources = await check(
  'Pixel attribution sources',
  `/v1/stores/${storeId}/pixel/attribution/sources?days=30&page=1&limit=20`,
);
const attributionMetaAds = await check(
  'Pixel Meta attribution',
  `/v1/stores/${storeId}/pixel/attribution/meta-ads?days=30&page=1&limit=20`,
);

let attributionPaths = null;
let productMappingEvidence = null;
let collectionMappingEvidence = null;
if (billing.body?.entitlements?.advancedAttribution === true) {
  attributionPaths = await check(
    'Advanced attribution paths',
    `/v1/stores/${storeId}/pixel/attribution/paths?days=30&page=1&limit=20`,
  );
  productMappingEvidence = await check(
    'Pixel product mapping evidence',
    `/v1/stores/${storeId}/pixel/attribution/mapping-evidence?days=30&page=1&limit=20&targetType=PRODUCT`,
  );
  collectionMappingEvidence = await check(
    'Pixel collection mapping evidence',
    `/v1/stores/${storeId}/pixel/attribution/mapping-evidence?days=30&page=1&limit=20&targetType=COLLECTION`,
  );
} else {
  results.push({
    name: 'Advanced attribution endpoints',
    ok: true,
    note: 'Skipped because current plan does not include ADVANCED_ATTRIBUTION.',
  });
}

const metaStatus = await check('Meta connection', `/v1/stores/${storeId}/integrations/meta/status`);
if (expectations.metaConnected) {
  assert(metaStatus.body?.connected === true, 'Expected Meta to be connected');
  assert(metaStatus.body?.configured === true, 'Expected Meta connection to be configured');
}

const dashboard = await check(
  'Analytics dashboard (fresh)',
  `/v1/stores/${storeId}/analytics/dashboard?days=30&fresh=true`,
);
assert(dashboard.body?.overview, 'Dashboard response is missing overview');

const report = await check(
  'Business brief (fresh)',
  `/v1/stores/${storeId}/analytics/report?days=30&fresh=true`,
);
assert(report.body?.overview, 'Business brief response is missing overview');

const intelligence = await check(
  'Intelligence snapshot (fresh)',
  `/v1/stores/${storeId}/intelligence/snapshot?fresh=true`,
);
assert(
  Array.isArray(intelligence.body?.recommendations),
  'Intelligence snapshot is missing recommendations[]',
);
assert(
  Array.isArray(intelligence.body?.dataQuality),
  'Intelligence snapshot is missing dataQuality[]',
);

const mappings = await check(
  'Product × Ads analytics',
  `/v1/stores/${storeId}/analytics/product-ads?days=30&page=1&limit=50`,
);
const mappingCoverage = mappings.body?.summary?.current?.mappingCoverage;
if (expectations.minimumMappingCoverage !== null) {
  assert(
    typeof mappingCoverage === 'number',
    'Product × Ads response does not expose numeric mappingCoverage',
  );
  assert(
    mappingCoverage >= expectations.minimumMappingCoverage,
    `Mapping coverage ${mappingCoverage} is below expected minimum ${expectations.minimumMappingCoverage}`,
  );
}

if (options.sendAuthEmail) {
  await check('Forgot-password email enqueue', '/v1/auth/forgot-password', {
    auth: false,
    method: 'POST',
    body: { email: options.authTestEmail },
  });
  results.push({
    name: 'Inbox verification',
    ok: true,
    note: `Request accepted for ${maskEmail(options.authTestEmail)}; confirm the message arrives and reset link works manually.`,
  });
}

printSummary({
  billing,
  billingPortal,
  pixelStatus,
  pixelHealth,
  pixelBehavior,
  pixelSessions,
  attributionSources,
  attributionMetaAds,
  attributionPaths,
  productMappingEvidence,
  collectionMappingEvidence,
  metaStatus,
  intelligence,
  mappings,
});

async function check(name, path, input = {}) {
  const method = input.method ?? 'GET';
  const auth = input.auth ?? true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(auth ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    const text = await response.text();
    const body = parseBody(text);
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      throw new Error(`${name} failed with HTTP ${response.status}: ${compactBody(body)}`);
    }

    results.push({ name, ok: true, status: response.status, durationMs });
    console.log(`PASS ${name} (${response.status}, ${durationMs} ms)`);
    return { response, body, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    results.push({
      name,
      ok: false,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function printSummary(context) {
  const highPriority = Array.isArray(context.intelligence.body?.recommendations)
    ? context.intelligence.body.recommendations.filter(
        (item) => item?.severity === 'HIGH' || item?.severity === 'CRITICAL',
      ).length
    : null;
  const blockedQuality = Array.isArray(context.intelligence.body?.dataQuality)
    ? context.intelligence.body.dataQuality.filter((item) => item?.status === 'BLOCKED').length
    : null;
  const linkedPurchases = Array.isArray(context.pixelSessions.body?.items)
    ? context.pixelSessions.body.items.filter(
        (session) => session?.orderLinkStatus === 'LINKED' && session?.order?.isTest === false,
      ).length
    : null;

  console.log('\nStride V1 release smoke summary');
  console.table(
    results.map((item) => ({
      check: item.name,
      result: item.ok ? 'PASS' : 'FAIL',
      http: item.status ?? '',
      ms: item.durationMs ?? '',
      note: item.note ?? item.error ?? '',
    })),
  );

  console.log('Release evidence:');
  console.log(`- Billing provider: ${context.billing.body?.provider ?? 'unknown'}`);
  console.log(`- Billing access active: ${String(context.billing.body?.accessActive ?? 'unknown')}`);
  console.log(`- Billing portal mode: ${context.billingPortal.body?.mode ?? 'unknown'}`);
  console.log(`- Pixel status: ${context.pixelStatus.body?.status ?? 'unknown'}`);
  console.log(
    `- Pixel last event: ${context.pixelStatus.body?.lastEventAt ?? context.pixelHealth.body?.lastEventAt ?? 'unknown'}`,
  );
  console.log(`- Recent linked non-test purchase sessions: ${linkedPurchases ?? 'unknown'}`);
  console.log(
    `- Meta connected/configured: ${String(context.metaStatus.body?.connected ?? false)}/${String(context.metaStatus.body?.configured ?? false)}`,
  );
  console.log(
    `- Intelligence findings: ${context.intelligence.body?.recommendations?.length ?? 'unknown'} (${highPriority ?? 'unknown'} high/critical)`,
  );
  console.log(`- Blocked data-quality surfaces: ${blockedQuality ?? 'unknown'}`);
  console.log(
    `- Product × Ads mapping coverage: ${formatPercent(context.mappings.body?.summary?.current?.mappingCoverage)}`,
  );

  console.log('\nThis command validates API-visible release evidence. It does not replace:');
  console.log('- clicking the real Shopify hosted pricing flow and exercising subscribe/change/cancel;');
  console.log('- confirming a real auth email arrives and its link completes the browser flow;');
  console.log('- performing the storefront checkout itself before enabling EXPECT_LINKED_PURCHASE_SESSION;');
  console.log('- validating Product × Ads against real ads when the connected provider account has usable ad data.');
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanEnv(name) {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function numberEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function optionalNumberEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compactBody(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return 'configured address';
  return `${local?.slice(0, 2) ?? ''}***@${domain}`;
}

function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : 'unknown';
}
