import { PollingWorker } from '../../lib/polling-worker.js';
import { integrationService } from '../integrations/integration.module.js';
import { TikTokApiService } from './shared/tiktok-api.service.js';
import { TikTokAuthService } from './shared/tiktok-auth.service.js';
import { TikTokRepository } from './tiktok.repository.js';
import { TikTokService } from './tiktok.service.js';
import { TikTokWebhookRepository } from './webhook/tiktok-webhook.repository.js';
import { TikTokWebhookService } from './webhook/tiktok-webhook.service.js';

const tiktokRepository = new TikTokRepository();
const tiktokApiService = new TikTokApiService();
const tiktokAuthService = new TikTokAuthService(tiktokRepository, tiktokApiService);

export const tiktokService = new TikTokService(
  tiktokRepository,
  tiktokAuthService,
  tiktokApiService,
  integrationService,
);

export const tiktokWebhookService = new TikTokWebhookService(
  new TikTokWebhookRepository(),
  tiktokService,
);

export const tiktokWebhookWorker = new PollingWorker(
  2_000,
  () => tiktokWebhookService.processDue(),
  'TikTok webhook worker failed',
);
