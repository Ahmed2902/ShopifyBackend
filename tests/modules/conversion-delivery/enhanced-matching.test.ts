import { describe, expect, it } from 'vitest';
import {
  customerIdentity,
  normalizeCustomerMatching,
  sha256,
  metaUserData,
  tiktokUserData,
  signalCoverage,
} from '../../../src/modules/conversion-delivery/matching.js';
import { storefrontEventKey } from '../../../src/modules/conversion-delivery/funnel.repository.js';

describe('provider matching normalization', () => {
  it('omits missing data instead of creating empty hashes', () => {
    expect(
      normalizeCustomerMatching({ emails: [' ', null], phones: [' ', '01000000000'] }),
    ).toEqual({});
  });
  it('normalizes email casing and whitespace and deduplicates arrays', () => {
    const match = normalizeCustomerMatching({
      emails: [' Example@Shop.com ', 'example@shop.com', 'invalid'],
    });
    expect(match.meta?.em).toEqual([sha256('example@shop.com')]);
    expect(match.tiktok?.email).toBe(sha256('example@shop.com'));
  });
  it('uses provider-specific phone and Gmail normalization', () => {
    const match = normalizeCustomerMatching({
      emails: [' First.Last+Shopping@ gmail.com '],
      phones: [' +20 (100) 123-4567 '],
    });
    expect(match.meta?.em).toBeUndefined();
    expect(match.meta?.ph).toEqual([sha256('201001234567')]);
    expect(match.tiktok?.phone).toBe(sha256('+201001234567'));
    expect(match.google?.userIdentifiers).toEqual([
      { emailAddress: sha256('firstlast@gmail.com') },
      { phoneNumber: sha256('+201001234567') },
    ]);
  });
  it('retains Unicode names and omits incomplete Google addresses', () => {
    const match = normalizeCustomerMatching({
      firstName: ' Ahmed! ',
      lastName: 'عبدالرحمن',
      city: 'New York',
      country: 'EG',
    });
    expect(match.meta?.fn).toEqual([sha256('ahmed')]);
    expect(match.meta?.ln).toEqual([sha256('عبدالرحمن')]);
    expect(match.meta?.ct).toEqual([sha256('newyork')]);
    expect(match.meta?.country).toEqual([sha256('eg')]);
    expect(match.google).toBeUndefined();
  });
  it('hashes Google names while retaining country and postcode as plain fields', () => {
    expect(
      normalizeCustomerMatching({
        firstName: 'Ahmed',
        lastName: 'Ali',
        country: 'eg',
        postalCode: ' 11835 ',
      }).google,
    ).toEqual({
      userIdentifiers: [
        {
          address: {
            givenName: sha256('ahmed'),
            familyName: sha256('ali'),
            regionCode: 'EG',
            postalCode: '11835',
          },
        },
      ],
    });
  });
  it('limits Google identifiers to ten distinct entries', () => {
    expect(
      normalizeCustomerMatching({
        emails: Array.from({ length: 20 }, (_, i) => `x${i}@example.com`),
      }).google?.userIdentifiers,
    ).toHaveLength(10);
  });
  it('sends browser and click identifiers without hashing and never fabricates them', () => {
    const now = new Date('2026-10-03T00:00:00Z');
    expect(metaUserData({}, null, now)).toEqual({});
    expect(tiktokUserData({}, null)).toEqual({});
    expect(metaUserData({ fbp: 'fb.1.1790985600000.123' }, 'actual-click', now)).toEqual({
      fbp: 'fb.1.1790985600000.123',
      fbc: `fb.1.${now.getTime()}.actual-click`,
    });
    expect(tiktokUserData({ ttp: 'actual-cookie' }, 'actual-click')).toEqual({
      ttp: 'actual-cookie',
      ttclid: 'actual-click',
    });
  });
  it('keeps customer IDs scoped to store and secret generation', () => {
    const a = customerIdentity('secret', 'a', 'gid://shopify/Customer/1');
    expect(customerIdentity('secret', 'a', 'gid://shopify/Customer/1')).toBe(a);
    expect(customerIdentity('secret', 'b', 'gid://shopify/Customer/1')).not.toBe(a);
    expect(customerIdentity('secret', 'a', 'gid://shopify/Customer/2')).not.toBe(a);
    expect(customerIdentity('rotated', 'a', 'gid://shopify/Customer/1')).not.toBe(a);
    expect(normalizeCustomerMatching({ externalId: a }).tiktok?.external_id).toBe(sha256(a));
  });
  it('does not report fabricated IP or Google external identifier coverage', () => {
    expect(
      signalCoverage(normalizeCustomerMatching({ externalId: 'scoped' }), 'GOOGLE_ADS', null),
    ).toMatchObject({ ip: false, externalId: false, email: false });
  });
  it('deduplicates retries while separating actions and stores', () => {
    expect(storefrontEventKey('a', '1')).toBe(storefrontEventKey('a', '1'));
    expect(storefrontEventKey('a', '1')).not.toBe(storefrontEventKey('b', '1'));
    expect(storefrontEventKey('a', '1')).not.toBe(storefrontEventKey('a', '2'));
  });
});

describe('provider-specific matching edge cases', () => {
  it('uses a valid ISO country only and keeps Google postal extensions separate from Meta normalization', () => {
    const match = normalizeCustomerMatching({ firstName: 'Jane', lastName: 'Doe', country: 'US', postalCode: ' 94043-1234 ' });
    expect(match.meta?.zp).toEqual([sha256('94043')]);
    expect(match.google?.userIdentifiers[0]).toMatchObject({ address: { regionCode: 'US', postalCode: '94043-1234' } });
    const invalid = normalizeCustomerMatching({ firstName: 'Jane', lastName: 'Doe', country: 'ZZ', postalCode: '12345' });
    expect(invalid.meta?.country).toBeUndefined();
    expect(invalid.google).toBeUndefined();
  });
  it('measures the identifiers each provider can actually receive', () => {
    const match = normalizeCustomerMatching({ emails: [' First.Last+shop@ gmail.com '] });
    expect(signalCoverage(match, 'META', null).email).toBe(false);
    expect(signalCoverage(match, 'TIKTOK', null).email).toBe(false);
    expect(signalCoverage(match, 'GOOGLE_ADS', null).email).toBe(true);
    const context = { clientIp: '203.0.113.9', userAgent: 'observed-agent' };
    expect(signalCoverage(context, 'META', null)).toMatchObject({ ip: true, userAgent: true });
    expect(signalCoverage(context, 'GOOGLE_ADS', null)).toMatchObject({ ip: false, userAgent: false });
  });
  it('does not mistake a raw click beginning with fb for an already formatted fbc', () => {
    const at = new Date('2026-10-03T00:00:00Z');
    expect(metaUserData({}, 'fb.raw-click', at).fbc).toBe(`fb.1.${at.getTime()}.fb.raw-click`);
  });
});

describe('actual Meta click-cookie evidence', () => {
  const at = new Date('2026-10-03T00:00:00Z');
  const cookie = 'fb.1.1790985600000.actual-click';
  it('uses an actual fbc cookie without requiring a fabricated click', () => {
    expect(metaUserData({ fbc: cookie }, null, at)).toEqual({ fbc: cookie });
    expect(signalCoverage({ fbc: cookie }, 'META', null).clickId).toBe(true);
    expect(tiktokUserData({ fbc: cookie }, null)).toEqual({});
  });
  it('preserves a matching cookie timestamp, but a stale cookie cannot replace a new click', () => {
    expect(metaUserData({ fbc: cookie }, 'actual-click', new Date(at.getTime() + 1000)).fbc).toBe(cookie);
    expect(metaUserData({ fbc: cookie }, 'new-click', at).fbc).toBe(`fb.1.${at.getTime()}.new-click`);
    expect(metaUserData({ fbc: 'invalid-cookie' }, null, at)).toEqual({});
  });
});
