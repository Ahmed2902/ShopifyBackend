import pino from 'pino';
import { reportException } from './monitoring.js';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  hooks: {
    logMethod(args, method, level) {
      if (level >= 50 && args[0] && typeof args[0] === 'object') {
        const entry = args[0] as { err?: unknown };
        reportException(args[0] instanceof Error ? args[0] : entry.err);
      }
      method.apply(this, args);
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.accessToken',
      '*.refreshToken',
      '*.accessTokenCiphertext',
    ],
    censor: '[REDACTED]',
  },
});
