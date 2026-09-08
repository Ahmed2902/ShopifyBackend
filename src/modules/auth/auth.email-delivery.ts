import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { authEmailSender, type AuthEmailSender } from './auth.email.js';
import { AuthRepository, type AuthTokenKind } from './auth.repository.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('auth-email-delivery:v1');
const MAX_ATTEMPTS = 8;
const PROCESSING_STALE_MS = 5 * 60 * 1000;
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');

if (key.length !== 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptToken(envelope: string): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = envelope.split('.');
  if (version !== VERSION || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error('Unsupported auth email token envelope');
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivEncoded, 'base64url'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

export class AuthEmailDeliveryService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly sender: AuthEmailSender = authEmailSender,
  ) {}

  async issueAndQueue(input: {
    userId: string;
    email: string;
    type: AuthTokenKind;
    token: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<string> {
    return this.repository.replaceAuthTokenAndQueueEmail({
      userId: input.userId,
      type: input.type,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      recipient: input.email,
      tokenCiphertext: encryptToken(input.token),
    });
  }

  async deliverNow(deliveryId: string): Promise<boolean> {
    const claimed = await this.repository.claimAuthEmailDelivery(
      deliveryId,
      new Date(Date.now() - PROCESSING_STALE_MS),
    );
    if (!claimed) return false;
    return this.deliverClaimed(claimed);
  }

  async processDue(limit = 20): Promise<{
    claimed: number;
    sent: number;
    failed: number;
    superseded: number;
    dead: number;
  }> {
    const ids = await this.repository.findDueAuthEmailDeliveryIds(
      limit,
      new Date(Date.now() - PROCESSING_STALE_MS),
    );
    let claimedCount = 0;
    let sent = 0;
    let failed = 0;
    let superseded = 0;
    let dead = 0;

    for (const id of ids) {
      const claimed = await this.repository.claimAuthEmailDelivery(
        id,
        new Date(Date.now() - PROCESSING_STALE_MS),
      );
      if (!claimed) continue;
      claimedCount += 1;
      const result = await this.deliverClaimed(claimed);
      if (result) sent += 1;
      else {
        const status = await this.repository.getAuthEmailDeliveryStatus(id);
        if (status === 'SUPERSEDED') superseded += 1;
        else if (status === 'DEAD') dead += 1;
        else failed += 1;
      }
    }

    return { claimed: claimedCount, sent, failed, superseded, dead };
  }

  private async deliverClaimed(delivery: {
    id: string;
    userId: string;
    type: AuthTokenKind;
    recipient: string;
    tokenHash: string;
    tokenCiphertext: string | null;
    attempts: number;
  }): Promise<boolean> {
    const current = await this.repository.findCurrentAuthToken(delivery.userId, delivery.type);
    if (
      !current ||
      current.tokenHash !== delivery.tokenHash ||
      current.usedAt ||
      current.expiresAt <= new Date() ||
      !delivery.tokenCiphertext
    ) {
      await this.repository.markAuthEmailDeliverySuperseded(delivery.id);
      return false;
    }

    try {
      const token = decryptToken(delivery.tokenCiphertext);
      if (delivery.type === 'EMAIL_VERIFICATION') {
        await this.sender.sendVerificationEmail(delivery.recipient, token);
      } else {
        await this.sender.sendPasswordResetEmail(delivery.recipient, token);
      }
      await this.repository.markAuthEmailDeliverySent(delivery.id);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      if (delivery.attempts >= MAX_ATTEMPTS) {
        await this.repository.markAuthEmailDeliveryDead(delivery.id, message);
        logger.error(
          { deliveryId: delivery.id, type: delivery.type, attempts: delivery.attempts },
          'Auth email delivery exhausted retries',
        );
        return false;
      }

      await this.repository.rescheduleAuthEmailDelivery(
        delivery.id,
        new Date(Date.now() + retryDelayMs(delivery.attempts)),
        message,
      );
      logger.warn(
        { deliveryId: delivery.id, type: delivery.type, attempts: delivery.attempts },
        'Auth email delivery scheduled for retry',
      );
      return false;
    }
  }
}

export const authEmailDeliveryService = new AuthEmailDeliveryService(new AuthRepository());
