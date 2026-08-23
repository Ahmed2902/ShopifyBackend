import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { router } from './routes.js';

const RAW_BODY_WEBHOOK_PATHS = [
  '/v1/integrations/shopify/webhooks',
  '/v1/integrations/tiktok/webhooks',
] as const;

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(
    express.json({
      limit: '1mb',
      verify(req, _res, buffer) {
        const request = req as express.Request;
        if (RAW_BODY_WEBHOOK_PATHS.some((path) => request.originalUrl.startsWith(path))) {
          request.rawBody = Buffer.from(buffer);
        }
      },
    }),
  );
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.context = {};
    next();
  });

  app.use(router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
