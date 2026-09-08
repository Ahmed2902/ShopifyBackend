import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendAuthEmailSender } from '../../../src/modules/auth/auth.email.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResendAuthEmailSender', () => {
  it('sends a branded verification email through Resend with the configured sender, token link, and idempotency key', async () => {
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
        'Idempotency-Key': expect.stringMatching(/^stride-auth\/verification\/[a-f0-9]{64}$/),
      },
    });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).not.toContain(
      'verification-token-value',
    );

    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(body.from).toBe('Test App <onboarding@resend.dev>');
    expect(body.to).toEqual(['owner@example.com']);
    expect(body.subject).toBe('Verify your Stride email');
    expect(body.text).toContain('This link expires in 24 hours.');
    expect(body.html).toContain('STRIDE');
    expect(body.html).toContain('Verify your email');
    expect(body.html).toContain(
      'http://localhost:3000/auth/verify-email?token=verification-token-value',
    );
  });

  it('sends a branded single-use password reset email with a separate idempotency namespace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ResendAuthEmailSender().sendPasswordResetEmail(
      'owner@example.com',
      'password-reset-token-value',
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      headers: {
        'Idempotency-Key': expect.stringMatching(/^stride-auth\/password-reset\/[a-f0-9]{64}$/),
      },
    });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).not.toContain(
      'password-reset-token-value',
    );

    const body = JSON.parse(init.body as string) as {
      subject: string;
      text: string;
      html: string;
    };
    expect(body.subject).toBe('Reset your Stride password');
    expect(body.text).toContain('one-time link expires in 30 minutes');
    expect(body.html).toContain('Reset your password');
    expect(body.html).toContain(
      'http://localhost:3000/auth/reset-password?token=password-reset-token-value',
    );
  });

  it('reuses the same Resend idempotency key when the same email attempt is retried', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const sender = new ResendAuthEmailSender();

    await sender.sendVerificationEmail('owner@example.com', 'same-token-value');
    await sender.sendVerificationEmail('owner@example.com', 'same-token-value');

    const firstHeaders = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]![1].headers as Record<string, string>;
    expect(firstHeaders['Idempotency-Key']).toBe(secondHeaders['Idempotency-Key']);
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

  it('maps network failures to a stable Resend delivery error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(
      new ResendAuthEmailSender().sendVerificationEmail(
        'owner@example.com',
        'verification-token-value',
      ),
    ).rejects.toMatchObject({
      code: 'EMAIL_DELIVERY_FAILED',
      statusCode: 502,
      details: { provider: 'resend' },
    });
  });
});