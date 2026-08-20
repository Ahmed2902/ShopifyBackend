import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseShopifyWebhookJson,
  shopifyGid,
  verifyShopifyWebhookHmac,
} from '../../../src/modules/shopify/webhook/shopify-webhook.utils.js';

function sign(body: Buffer): string {
  return createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET!).update(body).digest('base64');
}

describe('Shopify webhook utilities', () => {
  it('accepts the HMAC for the exact raw request body', () => {
    const body = Buffer.from('{"id":123,"title":"A"}');
    expect(() => verifyShopifyWebhookHmac(body, sign(body))).not.toThrow();
  });

  it('rejects a valid signature when the raw request body was changed', () => {
    const original = Buffer.from('{"id":123}');
    const changed = Buffer.from('{"id":124}');

    expect(() => verifyShopifyWebhookHmac(changed, sign(original))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SHOPIFY_WEBHOOK_HMAC' }),
    );
  });

  it('rejects malformed JSON after signature verification', () => {
    expect(() => parseShopifyWebhookJson(Buffer.from('{bad json'))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SHOPIFY_WEBHOOK_BODY' }),
    );
  });

  it('normalizes numeric Shopify webhook IDs to GraphQL GIDs without double-wrapping GIDs', () => {
    expect(shopifyGid('Product', 42)).toBe('gid://shopify/Product/42');
    expect(shopifyGid('Product', 'gid://shopify/Product/42')).toBe('gid://shopify/Product/42');
  });
});
