import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env.js';
import type { AuthService } from '../../../src/modules/auth/auth.service.js';
import {
  googleCallback,
  googleOAuthInternals,
  googleRedirect,
} from '../../../src/modules/auth/google.oauth.js';

function responseMock() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  const redirect = vi.fn();
  const res = { cookie, clearCookie, redirect } as unknown as Response;
  return { res, cookie, clearCookie, redirect };
}

describe('Google OAuth protocol', () => {
  it('uses state, PKCE S256, and an OIDC nonce derived from the verifier', () => {
    const { res, cookie, redirect } = responseMock();
    googleRedirect({} as Request, res);

    expect(cookie).toHaveBeenCalledTimes(2);
    const state = cookie.mock.calls[0]?.[1] as string;
    const verifier = cookie.mock.calls[1]?.[1] as string;
    const cookieOptions = cookie.mock.calls[0]?.[2];
    const location = redirect.mock.calls[0]?.[1] as string;
    const url = new URL(location);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(env.GOOGLE_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      googleOAuthInternals.sha256Base64Url(verifier),
    );
    expect(url.searchParams.get('nonce')).toBe(googleOAuthInternals.nonceForVerifier(verifier));
    expect(cookieOptions).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/v1/auth/google' });
  });

  it('does not clear a legitimate pending flow when callback state is forged', async () => {
    const handler = googleCallback({} as AuthService);
    const req = {
      query: { state: 'attacker-state' },
      cookies: {
        google_oauth_state: 'real-state',
        google_oauth_verifier: 'verifier',
      },
    } as unknown as Request;
    const { res, clearCookie, redirect } = responseMock();
    const next = vi.fn() as unknown as NextFunction;

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'GOOGLE_OAUTH_STATE_INVALID', statusCode: 400 }),
    );
    expect(clearCookie).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('validates state before accepting a Google denial callback', async () => {
    const handler = googleCallback({} as AuthService);
    const req = {
      query: { error: 'access_denied', state: 'real-state' },
      cookies: {
        google_oauth_state: 'real-state',
        google_oauth_verifier: 'verifier',
      },
    } as unknown as Request;
    const { res, clearCookie, redirect } = responseMock();
    const next = vi.fn() as unknown as NextFunction;

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(clearCookie).toHaveBeenCalledTimes(2);
    const location = redirect.mock.calls[0]?.[1] as string;
    const url = new URL(location);
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('error')).toBe('GOOGLE_OAUTH_DENIED');
  });

  it('uses secure short-lived OAuth cookies in production', () => {
    expect(googleOAuthInternals.oauthCookieOptions('production')).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/v1/auth/google',
      maxAge: 10 * 60 * 1000,
    });
  });
});
