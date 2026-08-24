import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  issueCsrfToken,
  requireCsrf,
  requireTrustedOrigin,
} from '../../src/middleware/csrf.middleware.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { rateLimit } from '../../src/middleware/rate-limit.middleware.js';

afterEach(() => vi.unstubAllGlobals());

describe('CSRF middleware', () => {
  it('requires a trusted frontend origin before issuing a token', async () => {
    const app = express();
    app.use(cookieParser());
    app.get('/csrf', requireTrustedOrigin, issueCsrfToken);
    app.use(errorHandler);

    await request(app).get('/csrf').expect(403);
    await request(app).get('/csrf').set('origin', 'https://attacker.example').expect(403);
    await request(app).get('/csrf').set('origin', 'http://localhost:3000').expect(200);
  });

  it('requires the matching cookie/header token on protected mutations', async () => {
    const app = express();
    app.use(cookieParser());
    app.get('/csrf', requireTrustedOrigin, issueCsrfToken);
    app.post('/protected', requireCsrf, (_req, res) => res.status(204).send());
    app.use(errorHandler);

    const agent = request.agent(app);
    const issued = await agent.get('/csrf').set('origin', 'http://localhost:3000').expect(200);
    const token = issued.body.csrfToken as string;

    await agent
      .post('/protected')
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', token)
      .expect(204);

    await agent.post('/protected').set('x-csrf-token', token).expect(403);

    await agent
      .post('/protected')
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', `${token}x`)
      .expect(403);

    await agent
      .post('/protected')
      .set('origin', 'https://attacker.example')
      .set('x-csrf-token', token)
      .expect(403);
  });
});

describe('rate limiting', () => {
  it('uses the shared Redis counter result for a concurrent burst', async () => {
    let count = 0;
    const redis = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      expect(command[0]).toBe('EVAL');
      expect(command[2]).toBe('1');
      count += 1;
      return new Response(JSON.stringify({ result: [count, 60_000] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', redis);

    const app = express();
    app.get(
      '/limited',
      rateLimit({ name: 'test-concurrency', max: 5, windowMs: 60_000, key: () => 'same' }),
      (_req, res) => res.status(204).send(),
    );
    app.use(errorHandler);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app).get('/limited')),
    );

    expect(responses.filter((response) => response.status === 204)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(redis).toHaveBeenCalledTimes(20);
  });

  it('fails closed when Redis is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('redis unavailable')));

    const app = express();
    app.get('/limited', rateLimit({ name: 'test', max: 5, windowMs: 60_000 }), (_req, res) =>
      res.status(204).send(),
    );
    app.use(errorHandler);

    const response = await request(app).get('/limited').expect(503);
    expect(response.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
  });
});
