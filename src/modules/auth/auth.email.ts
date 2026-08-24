import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

export interface AuthEmailSender {
  sendVerificationEmail(email: string, token: string): Promise<void>;
  sendPasswordResetEmail(email: string, token: string): Promise<void>;
}

function linkWithToken(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });
  } catch {
    throw new AppError('Email delivery failed', 502, 'EMAIL_DELIVERY_FAILED');
  }

  if (!response.ok) {
    throw new AppError('Email delivery failed', 502, 'EMAIL_DELIVERY_FAILED', {
      provider: 'resend',
      status: response.status,
    });
  }
}

export class ResendAuthEmailSender implements AuthEmailSender {
  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const link = linkWithToken(env.EMAIL_VERIFICATION_URL, token);
    await sendEmail({
      to: email,
      subject: 'Verify your email',
      text: `Verify your email address by opening this link: ${link}\n\nThis link expires in 24 hours.`,
      html: `<p>Verify your email address to finish creating your account.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
    });
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const link = linkWithToken(env.PASSWORD_RESET_URL, token);
    await sendEmail({
      to: email,
      subject: 'Reset your password',
      text: `Reset your password by opening this link: ${link}\n\nThis link expires in 30 minutes. If you did not request this, you can ignore this email.`,
      html: `<p>We received a request to reset your password.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
    });
  }
}

export const authEmailSender = new ResendAuthEmailSender();
