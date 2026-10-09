import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const secret = 'never-print-this-fixture-secret-123456789';
const fixture = {
  NODE_ENV: 'production',
  LEGACY_MERCHANT_AUTH_ENABLED: 'false',
  APP_URL: 'https://api.metrico.live',
  FRONTEND_URL: 'https://app.metrico.live',
  CORS_ORIGIN: 'https://app.metrico.live',
  DATABASE_URL: 'postgresql://fixture:fixture@localhost:5432/fixture',
  REDIS_REST_URL: 'https://cache.fixture.test',
  REDIS_REST_TOKEN: secret,
  JWT_ACCESS_SECRET: secret,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  SHOPIFY_CLIENT_ID: 'fixture-client',
  SHOPIFY_CLIENT_SECRET: secret,
  SHOPIFY_SCOPES: 'read_products,read_orders',
  SHOPIFY_REDIRECT_URI: 'https://app.metrico.live/api/shopify/callback',
  SHOPIFY_STATE_SECRET: secret,
  SHOPIFY_APP_PRICING_ENABLED: 'true',
  SHOPIFY_PARTNER_ORG_ID: '123',
  SHOPIFY_PARTNER_API_ACCESS_TOKEN: secret,
  SHOPIFY_PARTNER_APP_ID: 'gid://shopify/App/123',
  SHOPIFY_APP_HANDLE: 'metrico-fixture',
  SHOPIFY_ESSENTIALS_PLAN_HANDLE: 'essentials-fixture',
  SHOPIFY_PRO_PLAN_HANDLE: 'pro-fixture',
  META_APP_ID: '123',
  META_APP_SECRET: secret,
  META_STATE_SECRET: secret,
};
function run(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'metrico-env-'));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./check-production-env.mjs', import.meta.url))],
      {
        cwd: directory,
        env: { ...fixture, ...overrides },
        encoding: 'utf8',
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(!output.includes(secret), 'configuration values must never be logged');
    assert.ok(
      !output.includes(fixture.TOKEN_ENCRYPTION_KEY),
      'encryption key must never be logged',
    );
    return { status: result.status, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test('valid production configuration passes without database or Redis access', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.output, /No network or account approvals were checked/);
});
test('unfilled settings are rejected by name', () => {
  const result = run({ META_APP_SECRET: 'REPLACE_WITH_EXISTING_META_APP_SECRET' });
  assert.equal(result.status, 1);
  assert.match(result.output, /META_APP_SECRET/);
  assert.doesNotMatch(result.output, /REPLACE_WITH_EXISTING/);
});
test('a wrong encryption key is rejected without printing it', () => {
  assert.equal(run({ TOKEN_ENCRYPTION_KEY: secret }).status, 1);
});
test('missing hosted pricing configuration is rejected', () => {
  assert.equal(run({ SHOPIFY_PRO_PLAN_HANDLE: '' }).status, 1);
});
test('schema errors report setting names without raw values', () => {
  const result = run({ GOOGLE_ADS_STATE_SECRET: 'short-private-fixture' });
  assert.equal(result.status, 1);
  assert.match(result.output, /GOOGLE_ADS_STATE_SECRET/);
  assert.doesNotMatch(result.output, /short-private-fixture/);
});
