import { env } from '../../../config/env.js';
import {
  advertisingReconciliationService,
  type AdvertisingReconciliationService,
} from '../../advertising/reconciliation/advertising-reconciliation.service.js';
import {
  asRecord,
  deriveTikTokDeliveryId,
  getTikTokWebhookAdvertiserIds,
  getTikTokWebhookTopic,
  parseTikTokDate,
  verifyTikTokWebhookSignature,
} from '../tiktok.utils.js';
import { TikTokWebhookRepository } from './tiktok-webhook.repository.js';

const STALE_PROCESSING_MS = 5 * 60_000;
type ReconciliationScheduler = Pick<AdvertisingReconciliationService, 'markTikTokUrgent'>;

export class TikTokWebhookService {
  constructor(
    private readonly repository: TikTokWebhookRepository,
    private readonly reconciliation: ReconciliationScheduler,
  ) {}

  async receive(input: {
    rawBody: Buffer | undefined;
    signature: string | undefined;
    payload: unknown;
  }) {
    verifyTikTokWebhookSignature(input.rawBody, input.signature);

    const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}), 'utf8');
    const payload = asRecord(input.payload);
    const advertiserIds = getTikTokWebhookAdvertiserIds(payload);
    const connections = await this.repository.findConnectionsByAdvertiserIds(advertiserIds);
    const topic = getTikTokWebhookTopic(payload);
    const triggeredAt = parseTikTokDate(
      payload.time ?? payload.timestamp ?? payload.create_time ?? payload.event_time,
    );
    const baseDeliveryId = deriveTikTokDeliveryId(payload, rawBody);

    if (connections.length === 0) {
      const result = await this.repository.createDelivery({
        externalDeliveryId: baseDeliveryId,
        connectionId: null,
        topic,
        triggeredAt,
        apiVersion: env.TIKTOK_API_VERSION,
        payload,
      });
      return {
        accepted: true,
        deliveries: [
          {
            duplicate: result.duplicate,
            deliveryId: result.delivery.id,
            status: result.delivery.status,
          },
        ],
      };
    }

    const deliveries = await Promise.all(
      connections.map(async (connection) => {
        const result = await this.repository.createDelivery({
          externalDeliveryId: `${baseDeliveryId}:${connection.tiktokConnectionId}`,
          connectionId: connection.tiktokConnectionId,
          topic,
          triggeredAt,
          apiVersion: env.TIKTOK_API_VERSION,
          payload,
        });
        return {
          duplicate: result.duplicate,
          deliveryId: result.delivery.id,
          status: result.delivery.status,
        };
      }),
    );

    return { accepted: true, deliveries };
  }

  async processDue(limit = 20) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    const ids = await this.repository.listDueDeliveryIds(limit, now, staleBefore);
    let claimed = 0;
    let processed = 0;
    let ignored = 0;
    let failed = 0;

    for (const id of ids) {
      if (!(await this.repository.tryClaim(id, now, staleBefore))) continue;
      claimed += 1;
      const delivery = await this.repository.getDelivery(id);
      if (!delivery) continue;
      if (!delivery.tiktokConnectionId || !delivery.tiktokConnection) {
        await this.repository.markIgnored(id, 'TikTok connection is unavailable');
        ignored += 1;
        continue;
      }

      try {
        const storeId = delivery.tiktokConnection.storeId;
        const topic = delivery.topic.toUpperCase();
        let kinds: string[] | null = null;
        if (topic === 'REPORT_DATA_CHANGE') {
          kinds = ['INSIGHTS'];
        } else if (topic.includes('CATALOG') || topic.includes('PRODUCT')) {
          kinds = ['CATALOG'];
        } else if (
          topic === 'AD_REVIEW' ||
          topic === 'AD_GROUP_REVIEW' ||
          topic === 'CREATIVE_FATIGUE' ||
          topic.includes('AD_ACCOUNT') ||
          topic.startsWith('WEBHOOK_')
        ) {
          kinds = ['HIERARCHY'];
        }

        if (!kinds) {
          await this.repository.markIgnored(id, `No reconciliation handler for ${delivery.topic}`);
          ignored += 1;
          continue;
        }

        const scheduled = await this.reconciliation.markTikTokUrgent(storeId, kinds);
        if (!scheduled) {
          await this.repository.markIgnored(id, 'TikTok connection is inactive or not configured');
          ignored += 1;
          continue;
        }
        await this.repository.markProcessed(id);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.markFailed(id, delivery.attempts, message);
        failed += 1;
      }
    }

    return { claimed, processed, ignored, failed };
  }
}

export const tiktokWebhookService = new TikTokWebhookService(
  new TikTokWebhookRepository(),
  advertisingReconciliationService,
);
