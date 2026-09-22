import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../src/errors/app-error.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function appWithFailure(error: unknown) {
  const app = express();
  app.use(express.json());
  app.post('/mcp', (_req, _res, next) => next(error));
  app.post('/regular', (_req, _res, next) => next(error));
  app.use(errorHandler);
  return app;
}

describe('MCP error boundary', () => {
  it('keeps middleware AppErrors inside the JSON-RPC envelope', async () => {
    const app = appWithFailure(
      new AppError('Your Stride subscription is not active.', 402, 'SUBSCRIPTION_REQUIRED', {
        selectedPlan: 'ESSENTIALS',
      }),
    );

    const response = await request(app).post('/mcp').send({
      jsonrpc: '2.0',
      id: 'billing-1',
      method: 'tools/list',
    });

    expect(response.status).toBe(402);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 'billing-1',
      error: {
        code: -32000,
        message: 'Your Stride subscription is not active.',
        data: {
          code: 'SUBSCRIPTION_REQUIRED',
          details: { selectedPlan: 'ESSENTIALS' },
        },
      },
    });
  });

  it('returns a JSON-RPC parse error for malformed MCP JSON', async () => {
    const app = express();
    app.use(express.json());
    app.post('/mcp', (_req, res) => res.status(204).end());
    app.use(errorHandler);

    const response = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send('{"jsonrpc":"2.0",');

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('maps OAuth grant failures to the standard token error shape', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post('/oauth/token', (_req, _res, next) =>
      next(new AppError('Invalid or expired refresh token', 400, 'MCP_INVALID_GRANT')),
    );
    app.use(errorHandler);

    const response = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token' });

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid or expired refresh token',
    });
  });

  it('maps malformed OAuth token parameters to invalid_request', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post('/oauth/token', (_req, _res, next) => {
      try {
        z.object({ client_id: z.string().min(1) }).parse({});
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);

    const response = await request(app).post('/oauth/token').type('form').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'invalid_request',
      error_description: 'The token request is malformed.',
    });
  });

  it('does not change the existing REST error envelope outside MCP/OAuth routes', async () => {
    const app = appWithFailure(new AppError('Store not found', 404, 'STORE_NOT_FOUND'));

    const response = await request(app).post('/regular').send({ id: 'rest-1' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'STORE_NOT_FOUND', message: 'Store not found' },
    });
  });
});
