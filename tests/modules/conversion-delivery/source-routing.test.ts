import { describe, expect, it } from 'vitest';
import {
  summarizeRouting,
  type RoutingTouch,
} from '../../../src/modules/conversion-delivery/source-routing.js';
const at = new Date('2026-10-13T10:00:00Z');
const generation = new Date('2026-09-01T00:00:00Z');
const touch = (x: Partial<RoutingTouch> = {}): RoutingTouch => ({
  eventAt: '2026-10-13T09:00:00Z',
  ...x,
});
describe('paid-touch routing independent of attribution credit', () => {
  it.each([
    [touch({ utmSource: 'instagram', utmMedium: 'paid_social' }), 'META'],
    [touch({ tiktokClickId: 'real-ttclid' }), 'TIKTOK'],
    [touch({ googleClickId: 'real-gclid' }), 'GOOGLE_ADS'],
    [touch({ googleWebBraidedClickId: 'real-wbraid' }), 'GOOGLE_ADS'],
    [touch({ googleBraidedClickId: 'real-gbraid' }), 'GOOGLE_ADS'],
  ])('routes only to an observed provider', (row, provider) => {
    expect(summarizeRouting([row as RoutingTouch], at, generation).eligibleProviders).toEqual([
      provider,
    ]);
  });
  it('routes TikTok then Meta to both, while last-paid-touch reporting credits Meta', () => {
    const result = summarizeRouting(
      [
        touch({ tiktokClickId: 'tt', eventAt: '2026-10-13T08:00:00Z' }),
        touch({ metaClickId: 'fb', utmSource: 'meta', utmMedium: 'paid_social' }),
      ],
      at,
      generation,
    );
    expect(result.eligibleProviders).toEqual(['TIKTOK', 'META']);
    expect(result.lastPaidTouch?.provider).toBe('META');
  });
  it('direct returns and repeated landing context do not overwrite or refresh the paid touch', () => {
    const result = summarizeRouting(
      [
        touch({ utmSource: 'meta', utmMedium: 'paid_social', eventAt: '2026-10-12T10:00:00Z' }),
        touch(),
        touch({ utmSource: 'meta', utmMedium: 'paid_social' }),
      ],
      at,
      generation,
    );
    expect(result.touches).toHaveLength(1);
    expect(result.lastPaidTouch?.observedAt).toBe('2026-10-12T10:00:00.000Z');
  });
  it.each([
    touch(),
    touch({ metaClickId: 'organic-fbclid' }),
    touch({ utmSource: 'google', utmMedium: 'organic' }),
    touch({ referrerUrl: 'https://instagram.com' }),
  ])('never turns direct, organic or browser context into a paid route', (row) => {
    expect(summarizeRouting([row], at, generation).eligibleProviders).toEqual([]);
  });
  it.each([
    touch({ metaClickId: 'fb', tiktokClickId: 'tt' }),
    touch({ tiktokClickId: 'tt', utmSource: 'google', utmMedium: 'cpc' }),
    touch({ tiktokClickId: 'tt', utmSource: 'tiktok', utmMedium: 'organic' }),
  ])('fails closed on conflicting evidence', (row) => {
    expect(summarizeRouting([row], at, generation)).toMatchObject({
      eligibleProviders: [],
      reason: 'AMBIGUOUS_TOUCH',
    });
  });
  it('excludes future, out-of-window and previous-installation observations', () => {
    const rows = [
      touch({ tiktokClickId: 'tt', eventAt: '2026-10-13T11:00:00Z' }),
      touch({ googleClickId: 'g', eventAt: '2026-09-01T11:00:00Z' }),
    ];
    expect(summarizeRouting(rows, at, generation).eligibleProviders).toEqual([]);
    expect(
      summarizeRouting([touch({ tiktokClickId: 'tt' })], at, new Date('2026-10-13T09:30:00Z'))
        .eligibleProviders,
    ).toEqual([]);
  });
  it('does not silently route a truncated history', () => {
    expect(
      summarizeRouting(
        Array.from({ length: 1001 }, () => touch({ tiktokClickId: 'tt' })),
        at,
        generation,
      ),
    ).toMatchObject({ eligibleProviders: [], reason: 'EVIDENCE_LIMIT_REACHED' });
  });
});
