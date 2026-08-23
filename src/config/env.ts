import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('shopify-intelligence-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().min(1),
  SHOPIFY_REDIRECT_URI: z.string().url(),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/).default('2026-07'),
  SHOPIFY_STATE_SECRET: z.string().min(32),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_SCOPES: z.string().min(1).default('ads_read,business_management,catalog_management'),
  META_REDIRECT_URI: z.string().url(),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  META_STATE_SECRET: z.string().min(32),
});

export const env = envSchema.parse(process.env);
