import type { Request, Response } from 'express';
import { tiktokWebhookService, type TikTokWebhookService } from './tiktok-webhook.service.js';

export class TikTokWebhookController {
  constructor(private readonly service: TikTokWebhookService) {}

  receive = async (req: Request, res: Response) => {
    const signatureHeader =
      req.header('TikTok-Signature') ?? req.header('tiktok-signature') ?? undefined;
    const result = await this.service.receive({
      rawBody: req.rawBody,
      signature: signatureHeader,
      payload: req.body,
    });
    res.status(200).json(result);
  };
}

export const tiktokWebhookController = new TikTokWebhookController(tiktokWebhookService);
