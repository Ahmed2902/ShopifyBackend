import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TikTokWebhookService } from '../../../src/modules/tiktok/webhook/tiktok-webhook.service.js';

function signed(payload: unknown) {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', 'test-tiktok-app-secret')
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  return { rawBody, signature: `t=${timestamp},s=${signature}` };
}

describe('TikTokWebhookService', () => {
  it('creates one durable delivery for every matching connection', async () => {
    const repository = {
      findConnectionsByAdvertiserIds: vi.fn().mockResolvedValue([
        { tiktokConnectionId: 'connection-a', storeId: 'store-a' },
        { tiktokConnectionId: 'connection-b', storeId: 'store-b' },
      ]),
      createDelivery: vi.fn().mockImplementation(async ({ externalDeliveryId }) => ({
        duplicate: false,
        delivery: { id: externalDeliveryId, status: 'QUEUED' },
      })),
    };
    const service = new TikTokWebhookService(repository as never, { markTikTokUrgent: vi.fn() });
    const payload = {
      request_id: 'delivery-1',
      object: 11,
      entry: [{ adv_id: '123' }],
    };
    const auth = signed(payload);

    const result = await service.receive({ ...auth, payload });

    expect(repository.findConnectionsByAdvertiserIds).toHaveBeenCalledWith(['123']);
    expect(repository.createDelivery).toHaveBeenCalledTimes(2);
    expect(repository.createDelivery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        externalDeliveryId: 'delivery-1:connection-a',
        connectionId: 'connection-a',
      }),
    );
    expect(repository.createDelivery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        externalDeliveryId: 'delivery-1:connection-b',
        connectionId: 'connection-b',
      }),
    );
    expect(result.deliveries).toHaveLength(2);
  });

  it('coalesces report-data webhooks into an urgent insights reconciliation signal', async () => {
    const repository = {
      listDueDeliveryIds: vi.fn().mockResolvedValue(['delivery-1']),
      tryClaim: vi.fn().mockResolvedValue(true),
      getDelivery: vi.fn().mockResolvedValue({
        id: 'delivery-1',
        attempts: 0,
        topic: 'REPORT_DATA_CHANGE',
        tiktokConnectionId: 'connection-a',
        tiktokConnection: { storeId: 'store-a' },
      }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      markIgnored: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const reconciliation = {
      markTikTokUrgent: vi.fn().mockResolvedValue({ id: 'state-1' }),
    };
    const service = new TikTokWebhookService(repository as never, reconciliation);

    await expect(service.processDue()).resolves.toMatchObject({
      claimed: 1,
      processed: 1,
      ignored: 0,
      failed: 0,
    });
    expect(reconciliation.markTikTokUrgent).toHaveBeenCalledWith('store-a', ['INSIGHTS']);
    expect(repository.markProcessed).toHaveBeenCalledWith('delivery-1');
  });

  it('does not call provider sync APIs directly for webhook bursts', async () => {
    const repository = {
      listDueDeliveryIds: vi.fn().mockResolvedValue(['delivery-1', 'delivery-2']),
      tryClaim: vi.fn().mockResolvedValue(true),
      getDelivery: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'delivery-1',
          attempts: 0,
          topic: 'AD_REVIEW',
          tiktokConnectionId: 'connection-a',
          tiktokConnection: { storeId: 'store-a' },
        })
        .mockResolvedValueOnce({
          id: 'delivery-2',
          attempts: 0,
          topic: 'AD_GROUP_REVIEW',
          tiktokConnectionId: 'connection-a',
          tiktokConnection: { storeId: 'store-a' },
        }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      markIgnored: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const reconciliation = {
      markTikTokUrgent: vi.fn().mockResolvedValue({ id: 'state-1' }),
    };
    const service = new TikTokWebhookService(repository as never, reconciliation);

    const result = await service.processDue();

    expect(result.processed).toBe(2);
    expect(reconciliation.markTikTokUrgent).toHaveBeenCalledTimes(2);
    expect(reconciliation.markTikTokUrgent).toHaveBeenNthCalledWith(1, 'store-a', ['HIERARCHY']);
    expect(reconciliation.markTikTokUrgent).toHaveBeenNthCalledWith(2, 'store-a', ['HIERARCHY']);
  });
});
