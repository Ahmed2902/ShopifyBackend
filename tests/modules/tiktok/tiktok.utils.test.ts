import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTikTokOAuthState,
  getTikTokWebhookAdvertiserIds,
  getTikTokWebhookTopic,
  toJsonSafe,
  verifyTikTokOAuthState,
  verifyTikTokWebhookSignature,
} from '../../../src/modules/tiktok/tiktok.utils.js';

describe('TikTok OAuth state', () => {
  it('round-trips a signed store/user context', () => {
    const state = createTikTokOAuthState(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(verifyTikTokOAuthState(state)).toMatchObject({
      userId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('rejects tampered state', () => {
    const state = createTikTokOAuthState('user', 'store');
    expect(() => verifyTikTokOAuthState(`${state}x`)).toThrow();
  });
});

describe('TikTok JSON serialization', () => {
  it('converts BigInt reporting counters to strings', () => {
    expect(toJsonSafe({ impressions: 123n, nested: { clicks: 7n } })).toEqual({
      impressions: '123',
      nested: { clicks: '7' },
    });
  });
});

describe('TikTok webhook parsing', () => {
  it('extracts advertiser ids from nested report-change entries', () => {
    expect(
      getTikTokWebhookAdvertiserIds({
        object: 11,
        entry: [{ adv_id: '100' }, { advertiser_id: '200' }, { adv_id: '100' }],
      }),
    ).toEqual(['100', '200']);
    expect(getTikTokWebhookTopic({ object: 11 })).toBe('REPORT_DATA_CHANGE');
    expect(getTikTokWebhookTopic({ object: 8 })).toBe('CREATIVE_FATIGUE');
  });

  it('verifies a fresh TikTok-Signature', () => {
    const rawBody = Buffer.from('{"object":11,"entry":[]}', 'utf8');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', 'test-tiktok-app-secret')
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    expect(() =>
      verifyTikTokWebhookSignature(rawBody, `t=${timestamp},s=${signature}`),
    ).not.toThrow();
  });

  it('rejects missing or invalid webhook signatures', () => {
    const rawBody = Buffer.from('{"object":11,"entry":[]}', 'utf8');
    expect(() => verifyTikTokWebhookSignature(rawBody, undefined)).toThrow();
    expect(() => verifyTikTokWebhookSignature(rawBody, 't=1,s=wrong')).toThrow();
  });
});
