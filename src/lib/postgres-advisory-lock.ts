import { Pool } from 'pg';
import { env } from '../config/env.js';

const advisoryLockPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 4,
  allowExitOnIdle: true,
});

export async function withPostgresAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const client = await advisoryLockPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    try {
      return await work();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    }
  } finally {
    client.release();
  }
}
