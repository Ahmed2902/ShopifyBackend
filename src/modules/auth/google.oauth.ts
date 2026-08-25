import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { googleCallbackUrl, googleFrontendCallbackUrl } from '../../config/public-urls.js';
import { AppError } from '../../errors/app-error.js';
import { logger } from '../../lib/logger.js';
import type { AuthService } from './auth.service.js';
import { sanitizeUserAgent, setRefreshCookie } from './auth.utils.js';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const OAUTH_TTL_MS = 10 * 60 * 1000;

const STATE_COOKIE = 'google_oauth_state';
const VERIFIER_COOKIE = 'google_oauth_verifier';

type GoogleTokenError = {
  error?: unknown;
  error_description?: unknown;
};

function tokenExchangeErrorCode(providerError: string): string {
  switch (providerError) {
    case 'invalid_grant':
      return 'GOOGLE_OAUTH_CODE_INVALID';
    case 'invalid_client':
      return 'GOOGLE_OAUTH_CLIENT_INVALID';
    case 'unauthorized_client':
      return 'GOOGLE_OAUTH_CLIENT_UNAUTHORIZED';
    default:
      return 'GOOGLE_OAUTH_FAILED';
  }
}

function oauthCookieOptions(nodeEnv: string = env.NODE_ENV): CookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: OAUTH_TTL_MS,
  };
}

function clearOauthCookies(res: Response): void {
  const { maxAge: _maxAge, ...options } = oauthCookieOptions();
  res.clearCookie(STATE_COOKIE, options);
  res.clearCookie(VERIFIER_COOKIE, options);
}

function requireGoogleConfig() {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) {
    throw new AppError('Google OAuth is not configured', 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
  }
  return { clientId, clientSecret, redirectUri: googleCallbackUrl() };
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function nonceForVerifier(verifier: string): string {
  return sha256Base64Url(`google-oauth-nonce:${verifier}`);
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validateState(req: Request): { verifier: string } {
  const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
  const storedState = req.cookies?.[STATE_COOKIE] as string | undefined;
  const verifier = req.cookies?.[VERIFIER_COOKIE] as string | undefined;

  if (!returnedState || !storedState || !verifier || !secureEqual(returnedState, storedState)) {
    throw new AppError('Invalid Google OAuth state', 400, 'GOOGLE_OAUTH_STATE_INVALID');
  }

  return { verifier };
}

export function googleRedirect(_req: Request, res: Response): void {
  const { clientId, redirectUri } = requireGoogleConfig();
  const state = randomBase64Url();
  const verifier = randomBase64Url(48);

  res.cookie(STATE_COOKIE, state, oauthCookieOptions());
  res.cookie(VERIFIER_COOKIE, verifier, oauthCookieOptions());

  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', sha256Base64Url(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('nonce', nonceForVerifier(verifier));
  url.searchParams.set('prompt', 'select_account');

  res.redirect(302, url.toString());
}

export function googleCallback(service: AuthService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let verifier: string;
    try {
      ({ verifier } = validateState(req));
    } catch (error) {
      next(error);
      return;
    }

    clearOauthCookies(res);

    if (typeof req.query.error === 'string') {
      res.redirect(302, googleFrontendCallbackUrl('GOOGLE_OAUTH_DENIED'));
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      res.redirect(302, googleFrontendCallbackUrl('GOOGLE_OAUTH_MISSING_CODE'));
      return;
    }

    try {
      const { clientId, clientSecret, redirectUri } = requireGoogleConfig();
      let tokenResponse: globalThis.Response;
      try {
        tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new AppError('Google token exchange failed', 502, 'GOOGLE_OAUTH_UNAVAILABLE');
      }

      if (!tokenResponse.ok) {
        const tokenError = (await tokenResponse.json().catch(() => null)) as GoogleTokenError | null;
        const providerError = typeof tokenError?.error === 'string' ? tokenError.error : 'unknown';
        const providerDescription =
          typeof tokenError?.error_description === 'string' ? tokenError.error_description : undefined;
        logger.warn(
          { status: tokenResponse.status, providerError, providerDescription },
          'Google OAuth token exchange was rejected',
        );
        throw new AppError(
          'Google rejected the authorization code',
          401,
          tokenExchangeErrorCode(providerError),
        );
      }

      const tokenBody = (await tokenResponse.json()) as { id_token?: unknown };
      if (typeof tokenBody.id_token !== 'string') {
        throw new AppError('Google returned no identity token', 502, 'GOOGLE_BAD_RESPONSE');
      }

      let claims: Awaited<ReturnType<typeof jwtVerify>>['payload'];
      try {
        ({ payload: claims } = await jwtVerify(tokenBody.id_token, GOOGLE_JWKS, {
          issuer: ['https://accounts.google.com', 'accounts.google.com'],
          audience: clientId,
          algorithms: ['RS256'],
        }));
      } catch (error) {
        logger.warn(
          { err: error },
          'Google OAuth returned an invalid identity token',
        );
        throw new AppError('Google returned an invalid identity token', 401, 'GOOGLE_OAUTH_ID_TOKEN_INVALID');
      }

      const expectedNonce = nonceForVerifier(verifier);
      if (typeof claims.nonce !== 'string' || !secureEqual(claims.nonce, expectedNonce)) {
        throw new AppError('Google identity nonce does not match', 401, 'GOOGLE_OAUTH_NONCE_INVALID');
      }

      if (
        typeof claims.sub !== 'string' ||
        typeof claims.email !== 'string' ||
        claims.email_verified !== true
      ) {
        throw new AppError('Google account email is not verified', 401, 'GOOGLE_EMAIL_UNVERIFIED');
      }

      const result = await service.oauthSignIn(
        {
          googleId: claims.sub,
          email: claims.email,
          name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
        },
        sanitizeUserAgent(req.get('user-agent')),
      );

      setRefreshCookie(res, result.refreshToken);
      res.redirect(302, googleFrontendCallbackUrl());
    } catch (error) {
      const errorCode = error instanceof AppError ? error.code : 'GOOGLE_OAUTH_FAILED';
      res.redirect(302, googleFrontendCallbackUrl(errorCode));
    }
  };
}

export const googleOAuthInternals = {
  oauthCookieOptions,
  nonceForVerifier,
  sha256Base64Url,
  tokenExchangeErrorCode,
};
