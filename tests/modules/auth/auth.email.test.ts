import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendAuthEmailSender } from '../../../src/modules/auth/auth.email.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResendAuthEmailSender', () => {
  it('sends verification mail through Resend with the configured sender and token link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ResendAuthEmailSender().sendVerificationEmail(
      'owner@example.com',
      'verification-token-value',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer re_test_key',
        'Content-Type': 'application/json',
      },
    });

    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string[];
      html: string;
    };
    expect(body.from).toBe('Test App <onboarding@resend.dev>');
    expect(body.to).toEqual(['owner@example.com']);
    expect(body.html).toContain(
      'http://localhost:3000/auth/verify-email?token=verification-token-value',
    );
  });

  it('maps Resend failures to a stable application error without exposing credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 422 })));

    await expect(
      new ResendAuthEmailSender().sendPasswordResetEmail(
        'owner@example.com',
        'password-reset-token-value',
      ),
    ).rejects.toMatchObject({
      code: 'EMAIL_DELIVERY_FAILED',
      statusCode: 502,
      details: { provider: 'resend', status: 422 },
    });
  });
});
