import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import {
  apiRateLimit,
  pixelIngressRateLimit,
  webhookRateLimit,
} from './middleware/rate-limit.middleware.js';
import { requestPerformanceMiddleware } from './middleware/request-performance.middleware.js';
import { router } from './routes.js';

const RAW_BODY_WEBHOOK_PATHS = [
  '/v1/integrations/shopify/webhooks',
  '/v1/integrations/tiktok/webhooks',
];
const PIXEL_INGRESS_PATH = '/v1/pixel/events';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export function createApp() {
  const app = express();
  const applicationCors = cors({ origin: env.CORS_ORIGIN, credentials: true });
  const pixelCors = cors({
    origin: '*',
    credentials: false,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86_400,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const id = requestId(req.headers['x-request-id']);
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  // Start the AsyncLocalStorage scope immediately after pino establishes the request id so all
  // downstream Prisma work—including authorization, rate-limit-adjacent application reads and
  // route handlers—contributes to the same request performance record.
  app.use(requestPerformanceMiddleware);
  app.use(helmet());
  app.use((req, res, next) => {
    if (req.path === PIXEL_INGRESS_PATH) return pixelCors(req, res, next);
    return applicationCors(req, res, next);
  });
  app.use('/v1', webhookRateLimit, pixelIngressRateLimit, apiRateLimit);

  // Shopify's strict web-pixel sandbox can use a simple text/plain POST without a CORS
  // preflight. Parse both text/plain and application/json here with a tighter ingress limit;
  // the controller owns JSON decoding and contract validation.
  app.use(
    PIXEL_INGRESS_PATH,
    express.text({ type: ['text/plain', 'application/json'], limit: '128kb' }),
  );
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
