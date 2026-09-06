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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function authEmailHtml(input: {
  preheader: string;
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
  expiry: string;
  securityNote: string;
}): string {
  const actionUrl = escapeHtml(input.actionUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;background:#f6f6f6;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111111;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f6f6;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e7e7;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:32px 36px 8px;font-size:18px;font-weight:800;letter-spacing:-0.02em;">STRIDE</td>
            </tr>
            <tr>
              <td style="padding:20px 36px 36px;">
                <h1 style="margin:0 0 14px;font-size:28px;line-height:1.2;letter-spacing:-0.03em;">${escapeHtml(input.title)}</h1>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#525252;">${escapeHtml(input.body)}</p>
                <a href="${actionUrl}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 18px;border-radius:10px;">${escapeHtml(input.actionLabel)}</a>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#737373;">${escapeHtml(input.expiry)}</p>
                <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#737373;">${escapeHtml(input.securityNote)}</p>
                <div style="margin:28px 0 12px;border-top:1px solid #eeeeee;"></div>
                <p style="margin:0 0 8px;font-size:12px;line-height:1.55;color:#8a8a8a;">If the button does not work, paste this link into your browser:</p>
                <p style="margin:0;font-size:12px;line-height:1.55;word-break:break-all;color:#525252;">${actionUrl}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    throw new AppError('Authentication email is not configured', 503, 'AUTH_EMAIL_NOT_CONFIGURED');
  }

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
      subject: 'Verify your Stride email',
      text: `Verify your email address to finish creating your Stride account:\n\n${link}\n\nThis link expires in 24 hours. If you did not create a Stride account, you can ignore this email.`,
      html: authEmailHtml({
        preheader: 'Verify your email to finish setting up your Stride account.',
        title: 'Verify your email',
        body: 'Confirm that this email address belongs to you before signing in to Stride.',
        actionLabel: 'Verify email',
        actionUrl: link,
        expiry: 'This one-time link expires in 24 hours.',
        securityNote: 'If you did not create a Stride account, you can safely ignore this email.',
      }),
    });
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const link = linkWithToken(env.PASSWORD_RESET_URL, token);
    await sendEmail({
      to: email,
      subject: 'Reset your Stride password',
      text: `Reset your Stride password:\n\n${link}\n\nThis one-time link expires in 30 minutes. If you did not request a password reset, you can ignore this email.`,
      html: authEmailHtml({
        preheader: 'Use this one-time link to reset your Stride password.',
        title: 'Reset your password',
        body: 'We received a request to choose a new password for your Stride account.',
        actionLabel: 'Reset password',
        actionUrl: link,
        expiry: 'This one-time link expires in 30 minutes.',
        securityNote: 'If you did not request this reset, ignore this email. Your password will not change.',
      }),
    });
  }
}

export const authEmailSender = new ResendAuthEmailSender();
