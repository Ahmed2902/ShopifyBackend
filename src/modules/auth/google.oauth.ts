import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthService } from './auth.service.js';
import { sanitizeUserAgent, setRefreshCookie } from './auth.utils.js';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const OAUTH_TTL_MS = 10 * 60 * 1000;

const STATE_COOKIE = 'google_oauth_state';
const VERIFIER_COOKIE = 'google_oauth_verifier';

function oauthCookieOptions(nodeEnv: string = env.NODE_ENV): CookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax',
    path: '/v1/auth/google',
    maxAge: OAUTH_TTL_MS,
  };
}

function clearOauthCookies(res: Response): void {
  const { maxAge: _maxAge, ...options } = oauthCookieOptions();
  res.clearCookie(STATE_COOKIE, options);
  res.clearCookie(VERIFIER_COOKIE, options);
}

function requireGoogleConfig() {
  const {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REDIRECT_URI: redirectUri,
    GOOGLE_FRONTEND_REDIRECT_URI: frontendRedirectUri,
  } = env;

  if (!clientId || !clientSecret || !redirectUri || !frontendRedirectUri) {
    throw new AppError('Google OAuth is not configured', 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
  }

  return { clientId, clientSecret, redirectUri, frontendRedirectUri };
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

function frontendRedirect(status: 'success' | 'error', errorCode?: string): string {
  const { frontendRedirectUri } = requireGoogleConfig();
  const url = new URL(frontendRedirectUri);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('status', status);
  if (errorCode) url.searchParams.set('error', errorCode);
  return url.toString();
}

function validateState(req: Request): { state: string; verifier: string } {
  const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
  const storedState = req.cookies?.[STATE_COOKIE] as string | undefined;
  const verifier = req.cookies?.[VERIFIER_COOKIE] as string | undefined;

  if (
    !returnedState ||
    !storedState ||
    !verifier ||
    !secureEqual(returnedState, storedState)
  ) {
    throw new AppError('Invalid Google OAuth state', 400, 'GOOGLE_OAUTH_STATE_INVALID');
  }

  return { state: returnedState, verifier };
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
      // Do not clear a legitimate in-progress flow when a forged callback has bad state.
      next(error);
      return;
    }

    // State is valid. Consume the one-time browser state before doing network or DB work.
    clearOauthCookies(res);

    if (typeof req.query.error === 'string') {
      res.redirect(302, frontendRedirect('error', 'GOOGLE_OAUTH_DENIED'));
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      res.redirect(302, frontendRedirect('error', 'GOOGLE_OAUTH_MISSING_CODE'));
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
        throw new AppError('Google rejected the authorization code', 401, 'GOOGLE_OAUTH_FAILED');
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
      } catch {
        throw new AppError('Google returned an invalid identity token', 401, 'GOOGLE_OAUTH_FAILED');
      }

      const expectedNonce = nonceForVerifier(verifier);
      if (typeof claims.nonce !== 'string' || !secureEqual(claims.nonce, expectedNonce)) {
        throw new AppError('Google identity nonce does not match', 401, 'GOOGLE_OAUTH_FAILED');
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
      res.redirect(302, frontendRedirect('success'));
    } catch (error) {
      const errorCode = error instanceof AppError ? error.code : 'GOOGLE_OAUTH_FAILED';
      res.redirect(302, frontendRedirect('error', errorCode));
    }
  };
}

export const googleOAuthInternals = {
  oauthCookieOptions,
  nonceForVerifier,
  sha256Base64Url,
};
