import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { recordPrismaQuery } from '../observability/request-performance.js';

// Prisma 7 delegates pooling to node-postgres. Configure the pool explicitly so the API/worker
// lifecycle is predictable across environments: keep warm connections long enough for interactive
// traffic, cap per-process fan-out, and fail connection acquisition instead of hanging forever.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
});
const basePrisma = new PrismaClient({ adapter });

async function measurePrismaOperation<T>(
  model: string | null,
  operation: string,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAtMs = performance.now();
  try {
    return await execute();
  } finally {
    const endedAtMs = performance.now();
    recordPrismaQuery({
      model,
      operation,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      startedAtMs,
      endedAtMs,
    });
  }
}

const instrumentedPrisma = basePrisma.$extends({
  name: 'request-performance-instrumentation',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        return measurePrismaOperation(model, operation, () => query(args));
      },
    },
    $queryRaw({ args, query }) {
      return measurePrismaOperation(null, '$queryRaw', () => query(args));
    },
    $executeRaw({ args, query }) {
      return measurePrismaOperation(null, '$executeRaw', () => query(args));
    },
    $queryRawUnsafe({ args, query }) {
      return measurePrismaOperation(null, '$queryRawUnsafe', () => query(args));
    },
    $executeRawUnsafe({ args, query }) {
      return measurePrismaOperation(null, '$executeRawUnsafe', () => query(args));
    },
  },
});

// Keep the public PrismaClient type stable at this single boundary. Query extensions retain
// the runtime API, while several repository helpers intentionally accept Prisma.TransactionClient.
export const prisma = instrumentedPrisma as unknown as PrismaClient;
