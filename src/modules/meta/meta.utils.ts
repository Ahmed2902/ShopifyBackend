import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { MetaOAuthContext } from './meta.types.js';

const META_OAUTH_CONTEXT_TTL_MS = 10 * 60 * 1000;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signOAuthPayload(payload: string): string {
  return createHmac('sha256', env.META_STATE_SECRET).update(payload).digest('base64url');
}

export function createMetaOAuthState(userId: string, storeId: string): string {
  const context: MetaOAuthContext = {
    nonce: randomBytes(32).toString('base64url'),
    userId,
    storeId,
    expiresAt: Date.now() + META_OAUTH_CONTEXT_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
  return `${payload}.${signOAuthPayload(payload)}`;
}

export function verifyMetaOAuthState(state: string | undefined): MetaOAuthContext {
  if (!state) throw new AppError('Meta OAuth state is missing', 401, 'INVALID_META_OAUTH_STATE');

  const [payload, signature, ...extra] = state.split('.');
  if (!payload || !signature || extra.length > 0 || !safeEqual(signOAuthPayload(payload), signature)) {
    throw new AppError('Meta OAuth state is invalid', 401, 'INVALID_META_OAUTH_STATE');
  }

  try {
    const context = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MetaOAuthContext;
    if (
      typeof context.nonce !== 'string' ||
      context.nonce.length < 32 ||
      typeof context.userId !== 'string' ||
      typeof context.storeId !== 'string' ||
      typeof context.expiresAt !== 'number' ||
      context.expiresAt < Date.now()
    ) {
      throw new Error('Invalid context payload');
    }
    return context;
  } catch {
    throw new AppError('Meta OAuth state is invalid or expired', 401, 'INVALID_META_OAUTH_STATE');
  }
}

export function configuredMetaScopes(): string[] {
  return [...new Set(env.META_SCOPES.split(',').map((scope) => scope.trim()).filter(Boolean))];
}

export function buildMetaAuthorizationUrl(userId: string, storeId: string) {
  const state = createMetaOAuthState(userId, storeId);
  const url = new URL(`https://www.facebook.com/${env.META_API_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', env.META_APP_ID);
  url.searchParams.set('redirect_uri', env.META_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', configuredMetaScopes().join(','));
  url.searchParams.set('response_type', 'code');
  return { authorizationUrl: url.toString(), state };
}

export function buildMetaSuccessRedirect(storeId: string): string {
  const destination = new URL('/app/integrations', env.CORS_ORIGIN);
  destination.searchParams.set('meta', 'connected');
  destination.searchParams.set('storeId', storeId);
  return destination.toString();
}

export function computeMetaAppSecretProof(accessToken: string): string {
  return createHmac('sha256', env.META_APP_SECRET).update(accessToken).digest('hex');
}

export function normalizeMetaAdAccountId(input: string): string {
  const accountId = input.trim().replace(/^act_/, '');
  if (!/^\d+$/.test(accountId)) {
    throw new AppError('Invalid Meta ad account ID', 400, 'INVALID_META_AD_ACCOUNT_ID');
  }
  return `act_${accountId}`;
}

export function parseMetaMinorAmount(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function parseMetaRecord<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(message, 502, 'META_BAD_RESPONSE');
  return parsed.data;
}

export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current) =>
      typeof current === 'bigint' ? current.toString() : current,
    ),
  ) as unknown;
}
