import { describe, expect, it } from 'vitest';
import {
  calculatePixelRetentionExpiresAt,
  extractStorefrontAttribution,
  isStorefrontBehaviorCaptureAllowed,
  sanitizeStorefrontUrl,
} from '../../../src/modules/pixel/pixel.privacy.js';

describe('Stride Pixel privacy helpers', () => {
  it('captures behavior only when consent is granted or tracking is not required', () => {
    expect(isStorefrontBehaviorCaptureAllowed('GRANTED')).toBe(true);
    expect(isStorefrontBehaviorCaptureAllowed('NOT_REQUIRED')).toBe(true);
    expect(isStorefrontBehaviorCaptureAllowed('UNKNOWN')).toBe(false);
    expect(isStorefrontBehaviorCaptureAllowed('DENIED')).toBe(false);
  });

  it('strips query strings, fragments and credentials from stored URLs', () => {
    expect(
      sanitizeStorefrontUrl(
        'https://user:secret@store.example/products/shirt?utm_source=meta&email=a%40b.com#reviews',
      ),
    ).toBe('https://store.example/products/shirt');

    expect(sanitizeStorefrontUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeStorefrontUrl('not-a-url')).toBeNull();
  });

  it('extracts only allowlisted attribution parameters before URL sanitization', () => {
    expect(
      extractStorefrontAttribution(
        'https://store.example/products/shirt?utm_source=meta&utm_medium=paid_social&utm_campaign=summer&fbclid=fb-123&gclid=g-456&ttclid=tt-789&email=ignored%40example.com',
      ),
    ).toEqual({
      utmSource: 'meta',
      utmMedium: 'paid_social',
      utmCampaign: 'summer',
      metaClickId: 'fb-123',
      googleClickId: 'g-456',
      tiktokClickId: 'tt-789',
    });
  });

  it('assigns a bounded retention expiry', () => {
    const receivedAt = new Date('2026-09-04T12:00:00.000Z');
    expect(calculatePixelRetentionExpiresAt(receivedAt).toISOString()).toBe(
      '2026-12-03T12:00:00.000Z',
    );

    expect(() => calculatePixelRetentionExpiresAt(receivedAt, 0)).toThrow(RangeError);
    expect(() => calculatePixelRetentionExpiresAt(receivedAt, 366)).toThrow(RangeError);
  });
});
