import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../../src/config/env.js';
import { tiktokCallbackUrl, tiktokWebhookUrl } from '../../../src/config/public-urls.js';
import {
  requireTikTokAppCredentials,
  requireTikTokStateSecret,
} from '../../../src/modules/tiktok/tiktok.config.js';

const original = {
  nodeEnv: env.NODE_ENV,
  appUrl: env.APP_URL,
  appId: env.TIKTOK_APP_ID,
  appSecret: env.TIKTOK_APP_SECRET,
  redirectUri: env.TIKTOK_REDIRECT_URI,
  stateSecret: env.TIKTOK_STATE_SECRET,
  webhookExplicit: env.TIKTOK_WEBHOOK_URL_EXPLICIT,
};

afterEach(() => {
  env.NODE_ENV = original.nodeEnv;
  env.APP_URL = original.appUrl;
  env.TIKTOK_APP_ID = original.appId;
  env.TIKTOK_APP_SECRET = original.appSecret;
  env.TIKTOK_REDIRECT_URI = original.redirectUri;
  env.TIKTOK_STATE_SECRET = original.stateSecret;
  env.TIKTOK_WEBHOOK_URL_EXPLICIT = original.webhookExplicit;
});

function expectNotConfigured(work: () => unknown) {
  try {
    work();
    throw new Error('Expected TikTok configuration guard to reject');
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 503, code: 'TIKTOK_NOT_CONFIGURED' });
  }
}

describe('TikTok lazy runtime configuration', () => {
  it('uses configured provider credentials when TikTok is enabled', () => {
    expect(requireTikTokAppCredentials()).toEqual({
      appId: original.appId,
      appSecret: original.appSecret,
    });
    expect(requireTikTokStateSecret()).toBe(original.stateSecret);
  });

  it('fails TikTok provider use explicitly instead of letting empty credentials reach TikTok', () => {
    env.TIKTOK_APP_ID = '';
    env.TIKTOK_APP_SECRET = '';
    env.TIKTOK_STATE_SECRET = '';

    expectNotConfigured(() => requireTikTokAppCredentials());
    expectNotConfigured(() => requireTikTokStateSecret());
  });

  it('does not weaken OAuth state signing when TikTok becomes lazy-configured', () => {
    env.TIKTOK_STATE_SECRET = 'too-short';

    expectNotConfigured(() => requireTikTokStateSecret());
  });

  it('rejects production provider use when the canonical backend URL points to localhost', () => {
    env.NODE_ENV = 'production';
    env.APP_URL = 'http://localhost:3001';

    expectNotConfigured(() => requireTikTokAppCredentials());
  });

  it('allows production provider use with a public canonical backend URL', () => {
    env.NODE_ENV = 'production';
    env.APP_URL = 'https://api.example.com';

    expect(requireTikTokAppCredentials()).toEqual({
      appId: original.appId,
      appSecret: original.appSecret,
    });
  });

  it('keeps a stable webhook URL available without making it a separate boot requirement', () => {
    expect(tiktokWebhookUrl()).toBe(env.TIKTOK_WEBHOOK_URL);
    expect(new URL(tiktokWebhookUrl()).pathname).toBe('/v1/integrations/tiktok/webhooks');
  });

  it('uses the canonical backend callback in production with an omitted or matching override', () => {
    env.NODE_ENV = 'production';
    env.APP_URL = 'https://api.example.com';
    env.TIKTOK_REDIRECT_URI = '';
    expect(tiktokCallbackUrl()).toBe('https://api.example.com/v1/integrations/tiktok/callback');
    env.TIKTOK_REDIRECT_URI = tiktokCallbackUrl();
    expect(tiktokCallbackUrl()).toBe(env.TIKTOK_REDIRECT_URI);
  });

  it.each([
    'http://localhost:3001/v1/integrations/tiktok/callback',
    'https://app.example.com/app/integrations/complete',
    'https://api.example.com/v1/integrations/tiktok/callback/',
  ])('rejects a conflicting production callback before redirecting to TikTok (%s)', (redirectUri) => {
    env.NODE_ENV = 'production';
    env.APP_URL = 'https://api.example.com';
    env.TIKTOK_REDIRECT_URI = redirectUri;
    expect(tiktokCallbackUrl).toThrowError(expect.objectContaining({
      statusCode: 503, code: 'TIKTOK_REDIRECT_CONFIGURATION_MISMATCH',
    }));
  });

  it('retains the explicit tunnel callback for local development', () => {
    env.NODE_ENV = 'development';
    env.APP_URL = 'http://localhost:3001';
    env.TIKTOK_REDIRECT_URI = 'https://tunnel.example.com/v1/integrations/tiktok/callback';
    expect(tiktokCallbackUrl()).toBe(env.TIKTOK_REDIRECT_URI);
  });
});
