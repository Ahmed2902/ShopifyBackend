import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  APP_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(1_800_000).default(300_000),
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  CORS_ORIGIN: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_REQUEST_PERFORMANCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SLOW_REQUEST_THRESHOLD_MS: z.coerce.number().int().positive().default(1_000),
  REDIS_REST_URL: z.string().url(),
  REDIS_REST_TOKEN: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('shopify-intelligence-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_FRONTEND_REDIRECT_URI: z.string().url().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(3).optional(),
  EMAIL_VERIFICATION_URL: z.string().url().optional(),
  PASSWORD_RESET_URL: z.string().url().optional(),
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().min(1),
  SHOPIFY_REDIRECT_URI: z.string().url(),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2026-07'),
  SHOPIFY_STATE_SECRET: z.string().min(32),
  SHOPIFY_APP_PRICING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SHOPIFY_PARTNER_ORG_ID: z.string().min(1).optional(),
  SHOPIFY_PARTNER_API_ACCESS_TOKEN: z.string().min(1).optional(),
  SHOPIFY_PARTNER_APP_ID: z.string().regex(/^gid:\/\/shopify\/App\/\d+$/).optional(),
  SHOPIFY_PARTNER_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2026-07'),
  SHOPIFY_APP_HANDLE: z.string().min(1).optional(),
  SHOPIFY_ESSENTIALS_PLAN_HANDLE: z.string().min(1).optional(),
  SHOPIFY_PRO_PLAN_HANDLE: z.string().min(1).optional(),
  SHOPIFY_BILLING_VERIFY_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  PIXEL_COLLECTOR_URL: z.string().url().optional(),
  PIXEL_RAW_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_SCOPES: z.string().min(1).default('ads_read'),
  META_REDIRECT_URI: z.string().url().optional(),
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v26.0'),
  META_STATE_SECRET: z.string().min(32),
  META_INITIAL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(365),
  META_REFRESH_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(35),
  TIKTOK_APP_ID: z.string().default(''),
  TIKTOK_APP_SECRET: z.string().default(''),
  TIKTOK_SCOPES: z.string().default(''),
  TIKTOK_REDIRECT_URI: z.string().url().optional(),
  TIKTOK_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v1.3'),
  TIKTOK_STATE_SECRET: z.string().default(''),
  TIKTOK_WEBHOOK_URL: z.string().url().optional(),
  TIKTOK_WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
});

const parsedEnv = envSchema.parse(process.env);
const vercelProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : undefined;
const appUrl = parsedEnv.APP_URL ?? vercelProductionUrl ?? `http://localhost:${parsedEnv.PORT}`;
const frontendUrl = parsedEnv.FRONTEND_URL ?? parsedEnv.CORS_ORIGIN ?? 'http://localhost:3000';
const backendOrigin = new URL(appUrl).origin;
const frontendOrigin = new URL(frontendUrl).origin;
const corsOrigin = new URL(parsedEnv.CORS_ORIGIN ?? frontendOrigin).origin;

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

if (parsedEnv.NODE_ENV === 'production') {
  if (isLoopbackUrl(appUrl)) {
    throw new Error('APP_URL must be a public backend URL in production');
  }
  if (isLoopbackUrl(frontendUrl)) {
    throw new Error('FRONTEND_URL (or CORS_ORIGIN) must be a public frontend URL in production');
  }
  if (isLoopbackUrl(corsOrigin)) {
    throw new Error('CORS_ORIGIN must not point to localhost in production');
  }
  if (isLoopbackUrl(parsedEnv.SHOPIFY_REDIRECT_URI)) {
    throw new Error('SHOPIFY_REDIRECT_URI must be a public callback URL in production');
  }
}

export const env = {
  ...parsedEnv,
  APP_URL: appUrl,
  FRONTEND_URL: frontendOrigin,
  CORS_ORIGIN: corsOrigin,
  EMAIL_VERIFICATION_URL:
    parsedEnv.EMAIL_VERIFICATION_URL ??
    new URL('/auth/verify-email', `${frontendOrigin}/`).toString(),
  PASSWORD_RESET_URL:
    parsedEnv.PASSWORD_RESET_URL ??
    new URL('/auth/reset-password', `${frontendOrigin}/`).toString(),
  TIKTOK_WEBHOOK_URL:
    parsedEnv.TIKTOK_WEBHOOK_URL ??
    new URL('/v1/integrations/tiktok/webhooks', `${backendOrigin}/`).toString(),
  TIKTOK_WEBHOOK_URL_EXPLICIT: Boolean(parsedEnv.TIKTOK_WEBHOOK_URL),
};