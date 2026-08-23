import { describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDatabase('TikTok foundation database schema', () => {
  it('keeps required connection arrays non-null in PostgreSQL', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'TikTokConnection'
        AND column_name IN ('selectedAdvertiserIds', 'selectedCatalogIds', 'scopes')
      ORDER BY column_name
    `;

    expect(columns).toHaveLength(3);
    expect(columns.every((column) => column.is_nullable === 'NO')).toBe(true);
  });
});
