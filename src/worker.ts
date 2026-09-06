import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startWorkers, stopWorkers } from './workers.js';

let shuttingDown = false;

startWorkers();
logger.info({ environment: env.NODE_ENV, processRole: 'worker' }, 'Stride background workers started');

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, processRole: 'worker' }, 'Shutting down Stride background workers');

  const forceExit = setTimeout(() => {
    logger.error('Forced worker shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await stopWorkers();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Worker shutdown failed');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
