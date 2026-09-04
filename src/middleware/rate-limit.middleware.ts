import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';

interface RateLimitOptions {
  name: string;
  max: number;
  windowMs: number;
  key?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

type RedisResult = { result?: unknown; error?: string };

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const localBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

function sourceIdentity(req: Request): string {
  return `ip:${hash(req.ip || req.socket.remoteAddress || 'unknown')}`;
}

function bearerToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

function refreshToken(req: Request): string | null {
  const value = req.cookies?.refresh_token;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function apiIdentity(req: Request): string {
  const bearer = bearerToken(req);
  if (bearer) return `bearer:${hash(bearer)}`;
  const refresh = refreshToken(req);
  if (refresh) return `refresh:${hash(refresh)}`;
  return sourceIdentity(req);
}

export function authIdentity(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
  if (email) return `email:${hash(email)}:${sourceIdentity(req)}`;

  const token = typeof req.body?.token === 'string' ? req.body.token : null;
  if (token) return `token:${hash(token)}:${sourceIdentity(req)}`;

  const refresh = refreshToken(req);
  if (refresh) return `refresh:${hash(refresh)}`;
  return sourceIdentity(req);
}

async function consume(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
  if (!env.REDIS_REST_URL || !env.REDIS_REST_TOKEN) {
    if (env.NODE_ENV !== 'development') {
      throw new AppError('Rate limiter unavailable', 503, 'RATE_LIMIT_UNAVAILABLE');
    }

    const now = Date.now();
    const current = localBuckets.get(key);
    const bucket =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    localBuckets.set(key, bucket);
    return { count: bucket.count, ttlMs: Math.max(1, bucket.resetAt - now) };
  }

  let response: Response;
  try {
    response = await fetch(env.REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['EVAL', RATE_LIMIT_SCRIPT, '1', `rate-limit:${key}`, String(windowMs)]),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw new AppError('Rate limiter unavailable', 503, 'RATE_LIMIT_UNAVAILABLE');
  }

  const payload = (await response.json().catch(() => null)) as RedisResult | null;
  if (!response.ok || !payload || payload.error || !Array.isArray(payload.result)) {
    throw new AppError('Rate limiter unavailable', 503, 'RATE_LIMIT_UNAVAILABLE');
  }

  const count = Number(payload.result[0]);
  const ttlMs = Number(payload.result[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
    throw new AppError('Rate limiter unavailable', 503, 'RATE_LIMIT_UNAVAILABLE');
  }

  return { count, ttlMs: Math.max(1, ttlMs) };
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    if (req.method === 'OPTIONS' || options.skip?.(req)) return next();

    try {
      const identity = options.key?.(req) ?? apiIdentity(req);
      const bucket = await consume(`${options.name}:${identity}`, options.windowMs);
      const retryAfter = Math.max(1, Math.ceil(bucket.ttlMs / 1_000));
      const resetAt = Math.ceil((Date.now() + bucket.ttlMs) / 1_000);

      res.setHeader('RateLimit-Limit', String(options.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
      res.setHeader('RateLimit-Reset', String(resetAt));

      if (bucket.count > options.max) {
        res.setHeader('Retry-After', String(retryAfter));
        return next(
          new AppError('Too many requests. Try again later.', 429, 'RATE_LIMITED', {
            retryAfterSeconds: retryAfter,
          }),
        );
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

const AUTH_COOKIE_PATHS = new Set(['/auth/csrf', '/auth/refresh', '/auth/logout']);
const isWebhook = (req: Request) => req.path.endsWith('/webhooks');
const isPixelIngress = (req: Request) => req.originalUrl.startsWith('/v1/pixel/events');

export const apiRateLimit = rateLimit({
  name: 'api',
  max: 600,
  windowMs: 5 * 60_000,
  skip: (req) =>
    env.NODE_ENV === 'test' ||
    AUTH_COOKIE_PATHS.has(req.path) ||
    isWebhook(req) ||
    isPixelIngress(req),
});

export const webhookRateLimit = rateLimit({
  name: 'webhook-ingress',
  max: 3_000,
  windowMs: 5 * 60_000,
  key: sourceIdentity,
  skip: (req) => env.NODE_ENV === 'test' || !isWebhook(req),
});

export const pixelIngressRateLimit = rateLimit({
  name: 'pixel-ingress',
  max: 6_000,
  windowMs: 5 * 60_000,
  key: sourceIdentity,
  skip: (req) => env.NODE_ENV === 'test' || !isPixelIngress(req),
});

export const authRateLimit = rateLimit({
  name: 'auth',
  max: 30,
  windowMs: 15 * 60_000,
  key: authIdentity,
});

export const loginRateLimit = rateLimit({
  name: 'login',
  max: 10,
  windowMs: 15 * 60_000,
  key: authIdentity,
});

export const emailRateLimit = rateLimit({
  name: 'email',
  max: 8,
  windowMs: 15 * 60_000,
  key: authIdentity,
});

export const refreshRateLimit = rateLimit({
  name: 'refresh',
  max: 60,
  windowMs: 15 * 60_000,
  key: authIdentity,
});

export const csrfRateLimit = rateLimit({
  name: 'csrf',
  max: 30,
  windowMs: 15 * 60_000,
  key: sourceIdentity,
});

//3shan bokraaaaa ehna hna hateeenn buckets bdl redis
//el oauth bayz msh fahm leehh
//ui el login wel dashboard msh gy m3aha el akhdar el feh dah 3ayz ashelo w akhleh zy systemly
