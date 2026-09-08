import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  APP_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
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
  // Keep App Pricing disabled until the public-app plans are configured in Partner Dashboard.
  // While disabled, Stride uses the internal 14-day Pro-equivalent trial for pre-launch testing.
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
  // TikTok is optional until a merchant actually connects it. Provider entry points
  // validate the complete credential/public-URL set when used instead of blocking core boot.
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
const frontendOrigin = new URL(parsedEnv.CORS_ORIGIN).origin;
const backendOrigin = parsedEnv.APP_URL
  ? new URL(parsedEnv.APP_URL).origin
  : `http://localhost:${parsedEnv.PORT}`;

export const env = {
  ...parsedEnv,
  EMAIL_VERIFICATION_URL:
    parsedEnv.EMAIL_VERIFICATION_URL ??
    new URL('/auth/verify-email', `${frontendOrigin}/`).toString(),
  PASSWORD_RESET_URL:
    parsedEnv.PASSWORD_RESET_URL ??
    new URL('/auth/reset-password', `${frontendOrigin}/`).toString(),
  // Keep a concrete development fallback for existing TikTok API code, while remembering whether
  // production supplied a real public webhook URL. Provider guards reject localhost-only
  // production configuration before any outbound TikTok request is attempted.
  TIKTOK_WEBHOOK_URL:
    parsedEnv.TIKTOK_WEBHOOK_URL ??
    new URL('/v1/integrations/tiktok/webhooks', `${backendOrigin}/`).toString(),
  TIKTOK_WEBHOOK_URL_EXPLICIT: Boolean(parsedEnv.TIKTOK_WEBHOOK_URL),
};
