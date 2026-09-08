import { describe, expect, it, vi } from 'vitest';
import type { AuthEmailSender } from '../../../src/modules/auth/auth.email.js';
import { AuthEmailDeliveryService } from '../../../src/modules/auth/auth.email-delivery.js';
import type { AuthRepository } from '../../../src/modules/auth/auth.repository.js';

function buildService() {
  const repository = {
    replaceAuthTokenAndQueueEmail: vi.fn().mockResolvedValue('delivery-1'),
    claimAuthEmailDelivery: vi.fn(),
    findDueAuthEmailDeliveryIds: vi.fn().mockResolvedValue([]),
    findCurrentAuthToken: vi.fn(),
    markAuthEmailDeliverySuperseded: vi.fn().mockResolvedValue({ count: 1 }),
    markAuthEmailDeliverySent: vi.fn().mockResolvedValue({ count: 1 }),
    rescheduleAuthEmailDelivery: vi.fn().mockResolvedValue({ count: 1 }),
    markAuthEmailDeliveryDead: vi.fn().mockResolvedValue({ count: 1 }),
    getAuthEmailDeliveryStatus: vi.fn(),
  };
  const sender = {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  };
  const service = new AuthEmailDeliveryService(
    repository as unknown as AuthRepository,
    sender as unknown as AuthEmailSender,
  );
  return { repository, sender, service };
}

describe('AuthEmailDeliveryService', () => {
  it('persists an encrypted token envelope instead of plaintext', async () => {
    const { repository, service } = buildService();
    await service.issueAndQueue({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'owner@example.com',
      type: 'EMAIL_VERIFICATION',
      token: 'raw-verification-token',
      tokenHash: 'hashed-token',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(repository.replaceAuthTokenAndQueueEmail).toHaveBeenCalledOnce();
    const input = repository.replaceAuthTokenAndQueueEmail.mock.calls[0]![0];
    expect(input.tokenCiphertext).not.toContain('raw-verification-token');
    expect(input).toMatchObject({
      recipient: 'owner@example.com',
      tokenHash: 'hashed-token',
      type: 'EMAIL_VERIFICATION',
    });
  });

  it('delivers a claimed current token and clears it through the sent transition', async () => {
    const { repository, sender, service } = buildService();
    await service.issueAndQueue({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'owner@example.com',
      type: 'EMAIL_VERIFICATION',
      token: 'raw-verification-token',
      tokenHash: 'hashed-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const ciphertext = repository.replaceAuthTokenAndQueueEmail.mock.calls[0]![0].tokenCiphertext;
    repository.claimAuthEmailDelivery.mockResolvedValue({
      id: 'delivery-1',
      userId: '11111111-1111-4111-8111-111111111111',
      type: 'EMAIL_VERIFICATION',
      recipient: 'owner@example.com',
      tokenHash: 'hashed-token',
      tokenCiphertext: ciphertext,
      attempts: 1,
    });
    repository.findCurrentAuthToken.mockResolvedValue({
      tokenHash: 'hashed-token',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.deliverNow('delivery-1')).resolves.toBe(true);
    expect(sender.sendVerificationEmail).toHaveBeenCalledWith(
      'owner@example.com',
      'raw-verification-token',
    );
    expect(repository.markAuthEmailDeliverySent).toHaveBeenCalledWith('delivery-1');
  });

  it('supersedes a queued delivery when a newer auth token replaced it', async () => {
    const { repository, sender, service } = buildService();
    repository.claimAuthEmailDelivery.mockResolvedValue({
      id: 'delivery-1',
      userId: '11111111-1111-4111-8111-111111111111',
      type: 'PASSWORD_RESET',
      recipient: 'owner@example.com',
      tokenHash: 'old-token-hash',
      tokenCiphertext: 'v1.fake.fake.fake',
      attempts: 1,
    });
    repository.findCurrentAuthToken.mockResolvedValue({
      tokenHash: 'new-token-hash',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.deliverNow('delivery-1')).resolves.toBe(false);
    expect(repository.markAuthEmailDeliverySuperseded).toHaveBeenCalledWith('delivery-1');
    expect(sender.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('reschedules provider failures for worker retry', async () => {
    const { repository, sender, service } = buildService();
    await service.issueAndQueue({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'owner@example.com',
      type: 'PASSWORD_RESET',
      token: 'raw-reset-token',
      tokenHash: 'hashed-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const ciphertext = repository.replaceAuthTokenAndQueueEmail.mock.calls[0]![0].tokenCiphertext;
    repository.claimAuthEmailDelivery.mockResolvedValue({
      id: 'delivery-1',
      userId: '11111111-1111-4111-8111-111111111111',
      type: 'PASSWORD_RESET',
      recipient: 'owner@example.com',
      tokenHash: 'hashed-token',
      tokenCiphertext: ciphertext,
      attempts: 1,
    });
    repository.findCurrentAuthToken.mockResolvedValue({
      tokenHash: 'hashed-token',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    sender.sendPasswordResetEmail.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.deliverNow('delivery-1')).resolves.toBe(false);
    expect(repository.rescheduleAuthEmailDelivery).toHaveBeenCalledWith(
      'delivery-1',
      expect.any(Date),
      'provider unavailable',
    );
    expect(repository.markAuthEmailDeliveryDead).not.toHaveBeenCalled();
  });
});
