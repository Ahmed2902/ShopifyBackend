import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { tiktokService, type TikTokService } from '../tiktok.service.js';
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

export class TikTokWebhookService {
  constructor(
    private readonly repository: TikTokWebhookRepository,
    private readonly tiktokService: TikTokService,
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
        if (topic === 'REPORT_DATA_CHANGE') {
          await this.tiktokService.syncInsights(storeId, 2);
        } else if (topic.includes('CATALOG') || topic.includes('PRODUCT')) {
          await this.tiktokService.syncCatalogs(storeId);
        } else if (
          topic === 'AD_REVIEW' ||
          topic === 'AD_GROUP_REVIEW' ||
          topic === 'CREATIVE_FATIGUE' ||
          topic.includes('AD_ACCOUNT') ||
          topic.startsWith('WEBHOOK_')
        ) {
          await this.tiktokService.syncAdsHierarchy(storeId);
        } else {
          await this.repository.markIgnored(id, `No reconciliation handler for ${delivery.topic}`);
          ignored += 1;
          continue;
        }
        await this.repository.markProcessed(id);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof AppError &&
          ['TIKTOK_NOT_CONNECTED', 'TIKTOK_CONNECTION_INACTIVE'].includes(error.code)
        ) {
          await this.repository.markIgnored(id, message);
          ignored += 1;
        } else {
          await this.repository.markFailed(id, delivery.attempts, message);
          failed += 1;
        }
      }
    }

    return { claimed, processed, ignored, failed };
  }
}

export const tiktokWebhookService = new TikTokWebhookService(
  new TikTokWebhookRepository(),
  tiktokService,
);
