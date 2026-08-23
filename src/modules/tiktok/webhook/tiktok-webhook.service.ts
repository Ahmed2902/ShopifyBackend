import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import type { TikTokService } from '../tiktok.service.js';
import {
  asRecord,
  deriveTikTokDeliveryId,
  getTikTokWebhookAdvertiserId,
  getTikTokWebhookTopic,
  parseTikTokDate,
  verifyTikTokWebhookSignature,
  verifyTikTokWebhookToken,
} from '../tiktok.utils.js';
import type { TikTokWebhookRepository } from './tiktok-webhook.repository.js';

const STALE_PROCESSING_MS = 5 * 60_000;

export class TikTokWebhookService {
  constructor(
    private readonly repository: TikTokWebhookRepository,
    private readonly tiktokService: TikTokService,
  ) {}

  async receive(input: {
    rawBody: Buffer | undefined;
    signature: string | undefined;
    token: string | undefined;
    payload: unknown;
  }) {
    if (input.token) {
      verifyTikTokWebhookToken(input.token);
    } else {
      verifyTikTokWebhookSignature(input.rawBody, input.signature);
    }

    const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}), 'utf8');
    const payload = asRecord(input.payload);
    const advertiserId = getTikTokWebhookAdvertiserId(payload);
    const connection = advertiserId ? await this.repository.findConnectionByAdvertiserId(advertiserId) : null;
    const topic = getTikTokWebhookTopic(payload);
    const triggeredAt = parseTikTokDate(payload.time ?? payload.timestamp ?? payload.create_time ?? payload.event_time);
    const result = await this.repository.createDelivery({
      externalDeliveryId: deriveTikTokDeliveryId(payload, rawBody),
      connectionId: connection?.tiktokConnectionId ?? null,
      topic,
      triggeredAt,
      apiVersion: env.TIKTOK_API_VERSION,
      payload,
    });
    return {
      accepted: true,
      duplicate: result.duplicate,
      deliveryId: result.delivery.id,
      status: result.delivery.status,
    };
  }

  async processDue(limit = 20) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    const ids = await this.repository.listDueDeliveryIds(limit, now, staleBefore);
    for (const id of ids) {
      if (!(await this.repository.tryClaim(id, now, staleBefore))) continue;
      const delivery = await this.repository.getDelivery(id);
      if (!delivery) continue;
      if (!delivery.tiktokConnectionId || !delivery.tiktokConnection) {
        await this.repository.markIgnored(id, 'TikTok connection is unavailable');
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
          continue;
        }
        await this.repository.markProcessed(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof AppError &&
          ['TIKTOK_NOT_CONNECTED', 'TIKTOK_CONNECTION_INACTIVE'].includes(error.code)
        ) {
          await this.repository.markIgnored(id, message);
        } else {
          await this.repository.markFailed(id, delivery.attempts, message);
        }
      }
    }
  }
}
