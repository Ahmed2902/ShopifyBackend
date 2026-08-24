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
    const service = new TikTokWebhookService(repository as never, {} as never);
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
});
