import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { recordOperationPrismaQuery } from '../observability/operation-performance.js';
import { recordPrismaQuery } from '../observability/request-performance.js';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
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
    const sample = {
      model,
      operation,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      startedAtMs,
      endedAtMs,
    };
    recordPrismaQuery(sample);
    recordOperationPrismaQuery(sample);
  }
}

const instrumentedPrisma = basePrisma.$extends({
  name: 'performance-instrumentation',
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

export const prisma = instrumentedPrisma as unknown as PrismaClient;
