import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { TikTokController } from '../../../src/modules/tiktok/tiktok.controller.js';
import type { TikTokService } from '../../../src/modules/tiktok/tiktok.service.js';
import { createTikTokOAuthState } from '../../../src/modules/tiktok/tiktok.utils.js';

function responseMock() {
  const redirect = vi.fn();
  const res = { redirect } as unknown as Response;
  return { res, redirect };
}

describe('TikTok OAuth callback', () => {
  it('exchanges a successful authorization code exactly once', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const storeId = '22222222-2222-4222-8222-222222222222';
    const state = createTikTokOAuthState(userId, storeId);
    const completeOAuthInstall = vi.fn().mockResolvedValue({ storeId });
    const controller = new TikTokController({ completeOAuthInstall } as unknown as TikTokService);
    const req = {
      query: { auth_code: 'single-use-code', state },
    } as unknown as Request;
    const { res, redirect } = responseMock();

    await controller.completeInstall(req, res);

    expect(completeOAuthInstall).toHaveBeenCalledTimes(1);
    expect(completeOAuthInstall).toHaveBeenCalledWith('single-use-code', state);
    expect(redirect).toHaveBeenCalledTimes(1);
    const destination = new URL(redirect.mock.calls[0]?.[1] as string);
    expect(destination.pathname).toBe('/app/integrations');
    expect(destination.searchParams.get('tiktok')).toBe('connected');
    expect(destination.searchParams.get('storeId')).toBe(storeId);
  });

  it('returns a valid provider denial to the integrations screen without exchanging a code', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const storeId = '22222222-2222-4222-8222-222222222222';
    const state = createTikTokOAuthState(userId, storeId);
    const completeOAuthInstall = vi.fn();
    const controller = new TikTokController({ completeOAuthInstall } as unknown as TikTokService);
    const req = {
      query: { error: 'access_denied', state },
    } as unknown as Request;
    const { res, redirect } = responseMock();

    await controller.completeInstall(req, res);

    expect(completeOAuthInstall).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledTimes(1);
    const destination = new URL(redirect.mock.calls[0]?.[1] as string);
    expect(destination.searchParams.get('tiktok')).toBe('error');
    expect(destination.searchParams.get('tiktokError')).toBe('TIKTOK_OAUTH_DENIED');
  });
});
