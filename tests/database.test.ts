import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDatabase('database bootstrap', () => {
  it('reports readiness against the migrated database', async () => {
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('contains the core migration-managed tables', async () => {
    const [result] = await prisma.$queryRaw<
      Array<{
        userTable: string | null;
        storeTable: string | null;
        shopifyConnectionTable: string | null;
      }>
    >`
      SELECT
        to_regclass('"User"')::text AS "userTable",
        to_regclass('"Store"')::text AS "storeTable",
        to_regclass('"ShopifyConnection"')::text AS "shopifyConnectionTable"
    `;

    expect(result?.userTable).not.toBeNull();
    expect(result?.storeTable).not.toBeNull();
    expect(result?.shopifyConnectionTable).not.toBeNull();
  });
});
