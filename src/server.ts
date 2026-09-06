import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startWorkers, stopWorkers } from './workers.js';

const runningOnVercel = process.env.VERCEL === '1';
const workersEnabled = !runningOnVercel;

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, environment: env.NODE_ENV, workersEnabled },
    'API listening',
  );
});

// Vercel may create multiple autoscaled HTTP instances and recycle them when idle. Starting
// polling loops in each instance would duplicate queue claims and still would not provide an
// always-on worker guarantee. Keep the web process stateless there; production polling workers
// must run in a dedicated persistent worker process until they are migrated to a queue/workflow.
if (workersEnabled) {
  startWorkers();
} else {
  logger.info('Polling workers disabled in Vercel HTTP runtime');
}

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server failed to close cleanly');
      process.exitCode = 1;
    }

    if (workersEnabled) await stopWorkers();
    await prisma.$disconnect();
    process.exit();
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
