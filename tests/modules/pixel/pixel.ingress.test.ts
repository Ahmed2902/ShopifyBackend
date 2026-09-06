import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/app.js';
import { pixelService } from '../../../src/modules/pixel/pixel.service.js';

const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function payload() {
  return {
    installationId,
    collectorToken: 'A'.repeat(43),
    events: [
      {
        eventId: 'event_001',
        eventName: 'PAGE_VIEW',
        eventAt: '2026-09-04T12:00:00.000Z',
        consentState: 'GRANTED',
        pageUrl: 'https://shop.example/products/shirt?utm_source=meta',
      },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Stride Pixel ingress', () => {
  it('accepts Shopify-sandbox-friendly text/plain JSON with public CORS', async () => {
    vi.spyOn(pixelService, 'ingest').mockResolvedValue({
      received: 1,
      persisted: 1,
      duplicates: 0,
      suppressedForConsent: 0,
    });

    const response = await request(createApp())
      .post('/v1/pixel/events')
      .set('Origin', 'https://shop.example')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(payload()));

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.body).toEqual({
      received: 1,
      persisted: 1,
      duplicates: 0,
      suppressedForConsent: 0,
    });
    expect(pixelService.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId,
        events: [expect.objectContaining({ eventId: 'event_001' })],
      }),
    );
  });

  it('returns a bounded 400 for malformed collector JSON', async () => {
    const response = await request(createApp())
      .post('/v1/pixel/events')
      .set('Content-Type', 'text/plain')
      .send('{not-json');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'PIXEL_INVALID_JSON' },
    });
  });
});
