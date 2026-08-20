import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';

export function verifyShopifyWebhookHmac(rawBody: Buffer, providedHmac: string): void {
  const expected = Buffer.from(
    createHmac('sha256', env.SHOPIFY_CLIENT_SECRET).update(rawBody).digest('base64'),
    'base64',
  );

  let provided: Buffer;
  try {
    provided = Buffer.from(providedHmac, 'base64');
  } catch {
    throw new AppError('Invalid Shopify webhook signature', 401, 'INVALID_SHOPIFY_WEBHOOK_HMAC');
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AppError('Invalid Shopify webhook signature', 401, 'INVALID_SHOPIFY_WEBHOOK_HMAC');
  }
}

export function parseShopifyWebhookJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw new AppError('Shopify webhook body is not valid JSON', 400, 'INVALID_SHOPIFY_WEBHOOK_BODY');
  }
}

export function shopifyGid(resource: string, value: string | number): string {
  const text = String(value);
  return text.startsWith('gid://shopify/') ? text : `gid://shopify/${resource}/${text}`;
}

export function shopifyWebhookUri(): string {
  return new URL('/v1/integrations/shopify/webhooks', env.SHOPIFY_REDIRECT_URI).toString();
}
