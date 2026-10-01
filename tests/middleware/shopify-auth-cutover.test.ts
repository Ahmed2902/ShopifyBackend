import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { requireAuth } from '../../src/middleware/auth.middleware.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createApp } from '../../src/app.js';
const rollback = env.LEGACY_MERCHANT_AUTH_ENABLED;
afterEach(() => { env.LEGACY_MERCHANT_AUTH_ENABLED = rollback; });
describe('Shopify-only merchant authentication', () => {
  it('blocks standalone merchant endpoints when rollback is disabled', async () => {
    env.LEGACY_MERCHANT_AUTH_ENABLED = false;
    const response = await request(createApp()).post('/v1/auth/login').send({ email: 'test@example.com', password: 'unused' }).expect(410);
    expect(response.body.error.code).toBe('SHOPIFY_AUTH_REQUIRED');
  });
  it('rejects legacy bearer tokens before authorizing a merchant', async () => {
    env.LEGACY_MERCHANT_AUTH_ENABLED = false;
    const app = express();
    app.get('/protected', requireAuth, (_req, res) => res.sendStatus(200)); app.use(errorHandler);
    expect((await request(app).get('/protected').set('Authorization', 'Bearer legacy').expect(401)).body.error.code).toBe('SHOPIFY_AUTH_REQUIRED');
  });
  it('exposes the invalid Shopify-session retry header to the frontend origin', async () => {
    const token = await new SignJWT({ dest: 'https://test.myshopify.com', sub: '123' })
      .setProtectedHeader({ alg: 'HS256' }).setAudience(env.SHOPIFY_CLIENT_ID)
      .setIssuer('https://test.myshopify.com/admin').setExpirationTime(1)
      .sign(new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET));
    const response = await request(createApp()).get('/v1/stores').set('Origin', env.CORS_ORIGIN)
      .set('Authorization', `Bearer ${token}`).expect(401);
    expect(response.headers['x-shopify-retry-invalid-session-request']).toBe('1');
    expect(response.headers['access-control-expose-headers']).toContain('X-Shopify-Retry-Invalid-Session-Request');
  });
});
