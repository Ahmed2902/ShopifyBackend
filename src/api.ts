import type { Server } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

let server: Server | null = null;
let shuttingDown = false;

server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, environment: env.NODE_ENV, processRole: 'api' },
    'Stride API listening',
  );
});

async function finishShutdown() {
  await prisma.$disconnect();
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, processRole: 'api' }, 'Shutting down Stride API');

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
    logger.error('Forced API shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
