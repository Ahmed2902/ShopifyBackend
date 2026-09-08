import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

describe('application foundation', () => {
  it('returns API discovery metadata at the root', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      service: 'stride-api',
      status: 'ok',
      api: '/v1',
      health: {
        live: '/health/live',
        ready: '/health/ready',
      },
    });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns liveness status', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns a structured 404', async () => {
    const response = await request(app).get('/missing');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
