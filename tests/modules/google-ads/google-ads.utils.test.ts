import { describe, expect, it } from 'vitest';
import {
  buildGoogleAdsAuthorizationUrl,
  buildGoogleAdsOAuthState,
  deterministicUuid,
  googleDate,
  microsToDecimal,
  normalizeCustomerId,
  verifyGoogleAdsOAuthState,
} from '../../../src/modules/google-ads/google-ads.utils.js';

describe('Google Ads normalization', () => {
  it('normalizes customer ids and rejects arbitrary canonical UUID input', () => {
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
    expect(() => normalizeCustomerId('550e8400-e29b-41d4-a716-446655440000')).toThrow();
  });

  it('converts cost_micros exactly without floating point loss', () => {
    expect(microsToDecimal('1')).toBe('0.000001');
    expect(microsToDecimal('1234567890123456')).toBe('1234567890.123456');
    expect(microsToDecimal('-2500000')).toBe('-2.5');
    expect(microsToDecimal(null)).toBeNull();
  });

  it('generates stable namespaced UUIDs', () => {
    const first = deterministicUuid('GOOGLE_ADS', '1234567890', 'CAMPAIGN', '42');
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deterministicUuid('GOOGLE_ADS', '1234567890', 'CAMPAIGN', '42')).toBe(first);
    expect(deterministicUuid('GOOGLE_ADS', '1234567890', 'AD', '42')).not.toBe(first);
  });

  it('parses Google Ads date segments as UTC dates only', () => {
    expect(googleDate('2026-09-23')?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(googleDate('09/23/2026')).toBeNull();
  });
});

describe('Google Ads OAuth state', () => {
  it('round-trips a signed short-lived store/user state and rejects tampering', () => {
    const state = buildGoogleAdsOAuthState('user-1', 'store-1');
    expect(verifyGoogleAdsOAuthState(state)).toMatchObject({ userId: 'user-1', storeId: 'store-1' });
    const [encoded, signature] = state.split('.');
    const tamperedEncoded = `${encoded!.startsWith('A') ? 'B' : 'A'}${encoded!.slice(1)}`;
    expect(() => verifyGoogleAdsOAuthState(`${tamperedEncoded}.${signature}`)).toThrow();
  });

  it('requests the dedicated adwords scope with offline refresh-token access', () => {
    const { authorizationUrl } = buildGoogleAdsAuthorizationUrl('user-1', 'store-1');
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});
