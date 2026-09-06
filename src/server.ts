import type { Server } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startWorkers, stopWorkers } from './workers.js';

const runningOnVercel = process.env.VERCEL === '1';
let server: Server | null = null;
let workersEnabled = false;

if (runningOnVercel) {
  // Vercel's Express runtime invokes the exported app directly. Do not bind a second listener or
  // start polling loops inside autoscaled HTTP instances.
  logger.info({ environment: env.NODE_ENV }, 'Vercel HTTP runtime initialized');
} else {
  workersEnabled = true;
  server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, environment: env.NODE_ENV, workersEnabled },
      'API listening',
    );
  });
  startWorkers();
}

let shuttingDown = false;

async function finishShutdown() {
  if (workersEnabled) await stopWorkers();
  await prisma.$disconnect();
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  if (!server) {
    await finishShutdown();
    return;
  }

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server failed to close cleanly');
      process.exitCode = 1;
    }

    await finishShutdown();
    process.exit();
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export default app;
