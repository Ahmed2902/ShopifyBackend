import { describe, expect, it } from 'vitest';
import { classifyAcquisition } from '../../../src/modules/pixel/acquisition.js';
import {
  extractStorefrontAttribution,
  sanitizeStorefrontUrl,
} from '../../../src/modules/pixel/pixel.privacy.js';

describe('normalized acquisition', () => {
  it.each([
    [{ metaClickId: 'fb' }, 'PAID_SOCIAL', 'META'],
    [{ tiktokClickId: 'tt' }, 'PAID_SOCIAL', 'TIKTOK'],
    [{ googleClickId: 'g' }, 'OTHER', 'GOOGLE'],
    [{ googleClickId: 'g', utmMedium: 'paid_search' }, 'PAID_SEARCH', 'GOOGLE'],
    [{ googleBraidedClickId: 'g' }, 'OTHER', 'GOOGLE'],
    [{ googleWebBraidedClickId: 'g' }, 'OTHER', 'GOOGLE'],
    [{ utmMedium: 'email', utmSource: 'klaviyo' }, 'EMAIL', 'KLAVIYO'],
    [{ utmMedium: 'affiliate', utmSource: 'partner' }, 'AFFILIATE', 'OTHER'],
    [{ utmMedium: 'paid_social', utmSource: 'ig' }, 'PAID_SOCIAL', 'INSTAGRAM'],
    [{ referrerUrl: 'https://www.google.com/search?q=private' }, 'ORGANIC_SEARCH', 'GOOGLE'],
    [{ referrerUrl: 'https://www.google.com.eg/' }, 'ORGANIC_SEARCH', 'GOOGLE'],
    [{ referrerUrl: 'https://www.bing.com/' }, 'ORGANIC_SEARCH', 'BING'],
    [{ referrerUrl: 'https://l.instagram.com/' }, 'ORGANIC_SOCIAL', 'INSTAGRAM'],
    [{ referrerUrl: 'https://www.tiktok.com/' }, 'ORGANIC_SOCIAL', 'TIKTOK'],
    [{ referrerUrl: 'https://example.com/' }, 'REFERRAL', 'OTHER'],
    [{ pageUrl: 'https://shop.example/' }, 'DIRECT', null],
    [
      { pageUrl: 'https://shop.example/product', referrerUrl: 'https://shop.example/' },
      'DIRECT',
      null,
    ],
    [{}, 'UNKNOWN', null],
    [{ referrerUrl: 'https://google.com.attacker.example/' }, 'REFERRAL', 'OTHER'],
  ] as const)('classifies %j', (input, channel, provider) => {
    expect(classifyAcquisition(input)).toMatchObject({ channel, provider, version: 1 });
  });
  it('uses stronger click evidence before contradictory UTMs and preserves conflict diagnostics', () => {
    expect(
      classifyAcquisition({
        metaClickId: 'fb',
        tiktokClickId: 'tt',
        utmMedium: 'email',
        utmSource: 'mailchimp',
      }),
    ).toMatchObject({
      channel: 'PAID_SOCIAL',
      provider: 'META',
      basis: 'META_CLICK',
      conflictingClickEvidence: true,
    });
  });
  it('keeps only allowlisted URL evidence and strips secrets from canonical URLs', () => {
    const url =
      'https://user:password@shop.example/products/hero?utm_source=google&gbraid=braid&wbraid=web&email=secret@example.com&token=secret#private';
    expect(extractStorefrontAttribution(url)).toEqual({
      utmSource: 'google',
      googleBraidedClickId: 'braid',
      googleWebBraidedClickId: 'web',
    });
    expect(sanitizeStorefrontUrl(url)).toBe('https://shop.example/products/hero');
  });
  it('rejects personal query values and removes canonical checkout secrets', () => {
    expect(
      extractStorefrontAttribution(
        'https://shop.example/?utm_source=email@example.com&fbclid=private@example.com',
      ),
    ).toEqual({});
    expect(sanitizeStorefrontUrl('https://shop.example/checkouts/token-secret?key=private')).toBe(
      'https://shop.example/checkouts',
    );
  });
});

describe('known Shopify tokenized URL paths', () => {
  it.each([
    ['/12345/checkouts/secret-token', '/checkouts'],
    ['/%63heckouts/secret-token', '/checkouts'],
    ['/12345/orders/secret-token', '/orders'],
    ['/cart/c/secret-token', '/cart'],
    ['/account/orders/secret-token', '/account'],
  ])('sanitizes %s without retaining the token', (path, canonical) => {
    expect(sanitizeStorefrontUrl('https://shop.example' + path + '?token=secret#private'))
      .toBe('https://shop.example' + canonical);
  });
});
