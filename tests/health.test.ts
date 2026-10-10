import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

afterEach(() => vi.restoreAllMocks());
describe('deployment health', () => {
  it('requires healthy workers in the combined deployment', async () => {
    const app = createApp();
    app.locals.workerHealthCheck = () => ({ healthy: false });
    const database = vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ value: 1 }]);
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
    expect(database).not.toHaveBeenCalled();
    expect((await request(app).get('/health/live')).status).toBe(200);
  });
  it('accepts traffic when the database and combined workers are healthy', async () => {
    const app = createApp();
    app.locals.workerHealthCheck = () => ({ healthy: true });
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ value: 1 }]);
    expect((await request(app).get('/health/ready')).status).toBe(200);
  });
  it('keeps API-only readiness independent of a separate worker process', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ value: 1 }]);
    expect((await request(createApp()).get('/health/ready')).status).toBe(200);
  });
  it('rejects traffic while the database is unavailable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('Database unavailable'));
    expect((await request(createApp()).get('/health/ready')).status).toBe(500);
  });
});
