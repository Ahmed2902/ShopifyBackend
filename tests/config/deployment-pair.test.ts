import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDeploymentPair } from '../../scripts/check-deployment-pair.mjs';

// Test-only domains; no DNS/network calls occur.
const backend = {
  APP_URL: 'https://api.metrico-fixture.dev',
  FRONTEND_URL: 'https://app.metrico-fixture.dev',
  SHOPIFY_CLIENT_ID: 'public-client',
  SHOPIFY_APP_URL: 'https://app.metrico-fixture.dev/app/overview',
  SHOPIFY_REDIRECT_URI: 'https://app.metrico-fixture.dev/api/shopify/callback',
  SHOPIFY_SUPPORT_EMAIL: 'support@metrico-fixture.dev',
  SHOPIFY_CLIENT_SECRET: 'sentinel-private-secret',
};
const frontend = {
  NEXT_PUBLIC_API_URL: backend.APP_URL,
  NEXT_PUBLIC_SITE_URL: `${backend.FRONTEND_URL}/`,
  NEXT_PUBLIC_SHOPIFY_API_KEY: backend.SHOPIFY_CLIENT_ID,
  NEXT_PUBLIC_SUPPORT_EMAIL: backend.SHOPIFY_SUPPORT_EMAIL,
};

describe('cross-deployment configuration gate', () => {
  it('accepts consistent public settings and omitted default CORS/collector settings', () => {
    expect(checkDeploymentPair(backend, frontend)).toEqual([]);
  });
  it('accepts the same TikTok callback used by the production backend', () => {
    expect(
      checkDeploymentPair(
        { ...backend, TIKTOK_REDIRECT_URI: `${backend.APP_URL}/v1/integrations/tiktok/callback` },
        frontend,
      ),
    ).toEqual([]);
  });
  it('allows a separate public marketing domain while keeping the embedded app paired', () => {
    expect(
      checkDeploymentPair(backend, {
        ...frontend,
        NEXT_PUBLIC_SITE_URL: 'https://metrico.live',
        NEXT_PUBLIC_APP_URL: backend.FRONTEND_URL,
      }),
    ).toEqual([]);
    expect(
      checkDeploymentPair(backend, {
        ...frontend,
        NEXT_PUBLIC_APP_URL: 'https://wrong.metrico.live',
      }).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    { NEXT_PUBLIC_API_URL: 'https://wrong.metrico-fixture.dev' },
    { NEXT_PUBLIC_SITE_URL: 'https://wrong.metrico-fixture.dev' },
    { NEXT_PUBLIC_SHOPIFY_API_KEY: 'wrong-client' },
    { NEXT_PUBLIC_SUPPORT_EMAIL: '' },
    { NEXT_PUBLIC_API_URL: 'http://localhost:3001' },
    { NEXT_PUBLIC_API_URL: 'https://user:sentinel-private-secret@api.metrico-fixture.dev' },
    { NEXT_PUBLIC_API_URL: 'https://api.metrico-fixture.dev/?token=sentinel-private-secret' },
    { NEXT_PUBLIC_SHOPIFY_CLIENT_SECRET: 'sentinel-private-secret' },
  ])(
    'rejects unsafe or inconsistent frontend settings without reporting values (%j)',
    (overrides) => {
      const errors = checkDeploymentPair(backend, { ...frontend, ...overrides });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join('\n')).not.toContain('sentinel-private-secret');
    },
  );
  it.each([
    { CORS_ORIGIN: 'https://wrong.metrico-fixture.dev' },
    { SHOPIFY_APP_URL: 'https://app.metrico-fixture.dev/' },
    { SHOPIFY_REDIRECT_URI: 'https://api.metrico-fixture.dev/api/shopify/callback' },
    { PIXEL_COLLECTOR_URL: 'https://wrong.metrico-fixture.dev/v1/pixel/events' },
    { TIKTOK_REDIRECT_URI: 'http://localhost:3001/v1/integrations/tiktok/callback' },
    { TIKTOK_REDIRECT_URI: `${backend.FRONTEND_URL}/app/integrations/complete` },
    { TIKTOK_REDIRECT_URI: `${backend.APP_URL}/v1/integrations/tiktok/callback/` },
  ])(
    'rejects routes that would break embedded installation, collector or CORS (%j)',
    (overrides) => {
      expect(checkDeploymentPair({ ...backend, ...overrides }, frontend).length).toBeGreaterThan(0);
    },
  );
  it('returns a failing CLI status without disclosing private values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrico-config-'));
    try {
      const serialize = (values: Record<string, string>) =>
        Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n');
      writeFileSync(join(dir, 'backend.env'), serialize(backend));
      writeFileSync(
        join(dir, 'frontend.env'),
        serialize({ ...frontend, NEXT_PUBLIC_SHOPIFY_API_KEY: 'wrong-client' }),
      );
      const result = spawnSync(
        process.execPath,
        [
          'scripts/check-deployment-pair.mjs',
          '--backend-env',
          join(dir, 'backend.env'),
          '--frontend-env',
          join(dir, 'frontend.env'),
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('NEXT_PUBLIC_SHOPIFY_API_KEY');
      expect(result.stderr + result.stdout).not.toContain(backend.SHOPIFY_CLIENT_SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
