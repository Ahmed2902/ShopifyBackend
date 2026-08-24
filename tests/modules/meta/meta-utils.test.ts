import { describe, expect, it } from 'vitest';
import { env } from '../../../src/config/env.js';
import {
  buildMetaAuthorizationUrl,
  computeMetaAppSecretProof,
  createMetaOAuthState,
  verifyMetaOAuthState,
} from '../../../src/modules/meta/meta.utils.js';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('Meta OAuth utilities', () => {
  it('creates a self-verifying state bound to the initiating user and store', () => {
    const state = createMetaOAuthState(userId, storeId);
    expect(verifyMetaOAuthState(state)).toMatchObject({ userId, storeId });
  });

  it('rejects a tampered state', () => {
    const state = createMetaOAuthState(userId, storeId);
    const tampered = `${state.slice(0, -1)}${state.endsWith('a') ? 'b' : 'a'}`;
    expect(() => verifyMetaOAuthState(tampered)).toThrowError(
      expect.objectContaining({ code: 'INVALID_META_OAUTH_STATE' }),
    );
  });

  it('builds the initial read-only authorization URL with only the core ads permission', () => {
    const { authorizationUrl } = buildMetaAuthorizationUrl(userId, storeId);
    const url = new URL(authorizationUrl);

    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe(`/${env.META_API_VERSION}/dialog/oauth`);
    expect(url.searchParams.get('client_id')).toBe(env.META_APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(env.META_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('ads_read');
    expect(url.searchParams.get('scope')).not.toContain('ads_management');
    expect(url.searchParams.get('scope')).not.toContain('business_management');
    expect(url.searchParams.get('scope')).not.toContain('catalog_management');
    expect(verifyMetaOAuthState(url.searchParams.get('state') ?? '')).toMatchObject({
      userId,
      storeId,
    });
  });

  it('computes deterministic appsecret_proof without exposing the app secret', () => {
    const proof = computeMetaAppSecretProof('token-value');
    expect(proof).toMatch(/^[a-f0-9]{64}$/);
    expect(proof).not.toContain(env.META_APP_SECRET);
    expect(proof).toBe(computeMetaAppSecretProof('token-value'));
  });
});
