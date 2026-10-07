import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startWorkers, stopWorkers, workerHealth } from './workers.js';
import { writeFile, rename, unlink } from 'node:fs/promises';

let shuttingDown = false;

startWorkers();
const healthPath = process.env.WORKER_HEALTH_FILE ?? '/tmp/metrico-worker-health.json';
let writingHealth = false;
async function heartbeat() {
  if (writingHealth || shuttingDown) return;
  writingHealth = true;
  try {
    await writeFile(
      `${healthPath}.tmp`,
      JSON.stringify({ updatedAt: Date.now(), ...workerHealth() }),
      { mode: 0o600 },
    );
    await rename(`${healthPath}.tmp`, healthPath);
  } catch (err) {
    logger.error({ err }, 'Could not write worker health status');
  } finally {
    writingHealth = false;
  }
}
void heartbeat();
const healthTimer = setInterval(() => void heartbeat(), 30_000);
logger.info(
  { environment: env.NODE_ENV, processRole: 'worker' },
  'Metrico background workers started',
);

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(healthTimer);
  await unlink(healthPath).catch(() => undefined);
  logger.info({ signal, processRole: 'worker' }, 'Shutting down Metrico background workers');

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
