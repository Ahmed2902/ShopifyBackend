import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

export const healthRouter = Router();

healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

healthRouter.get('/ready', async (req, res) => {
  const workerHealthCheck = req.app.locals.workerHealthCheck as
    (() => { healthy: boolean }) | undefined;
  if (workerHealthCheck && !workerHealthCheck().healthy) {
    res.status(503).json({ status: 'not_ready' });
    return;
  }
  await prisma.$queryRaw`SELECT 1`;
  res.status(200).json({ status: 'ready' });
});
