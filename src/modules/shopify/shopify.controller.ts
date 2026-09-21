import type { Request, Response } from 'express';
import { shopifyDisconnectService } from './shopify-disconnect.service.js';
import { shopifyOrderBackfillParamsSchema } from './order/shopify-order.schema.js';
import { shopifyCallbackSchema, shopifyInstallSchema } from './shopify.schema.js';
import { shopifySyncQueueService, type ShopifySyncQueueService } from './shopify-sync-queue.service.js';
import { shopifySyncRunParamsSchema } from './shopify-sync.schema.js';
import { shopifyService, type ShopifyService } from './shopify.service.js';
import {
  buildShopifySuccessRedirect,
  clearShopifyOAuthCookie,
  setShopifyOAuthCookie,
  SHOPIFY_OAUTH_COOKIE_NAME,
  verifyShopifyCallbackTimestamp,
  verifyShopifyOAuthHmac,
} from './shopify.utils.js';

export class ShopifyController {
  constructor(
    private readonly service: ShopifyService,
    private readonly syncQueue?: Pick<ShopifySyncQueueService, 'enqueue' | 'get'>,
  ) {}

  install = async (req: Request, res: Response) => {
    const { shop } = shopifyInstallSchema.parse(req.body);
    const oauth = this.service.beginOAuth(req.context.userId!, shop);

    setShopifyOAuthCookie(res, oauth.cookieValue);
    res.status(200).json({
      shop: oauth.shop,
      authorizationUrl: oauth.authorizationUrl,
    });
  };

  callback = async (req: Request, res: Response) => {
    const callbackUrl = new URL(req.originalUrl, 'http://localhost');
    verifyShopifyOAuthHmac(callbackUrl.searchParams);

    const query = shopifyCallbackSchema.parse({
      code: callbackUrl.searchParams.get('code'),
      shop: callbackUrl.searchParams.get('shop'),
      state: callbackUrl.searchParams.get('state'),
      hmac: callbackUrl.searchParams.get('hmac'),
      timestamp: callbackUrl.searchParams.get('timestamp'),
    });

    verifyShopifyCallbackTimestamp(query.timestamp);

    const result = await this.service.completeOAuth({
      code: query.code,
      shop: query.shop,
      state: query.state,
      oauthContextCookie: req.cookies?.[SHOPIFY_OAUTH_COOKIE_NAME] as string | undefined,
    });

    clearShopifyOAuthCookie(res);
    res.redirect(303, buildShopifySuccessRedirect(result.storeId, result.shop));
  };

  webhook = async (req: Request, res: Response) => {
    const result = await this.service.receiveWebhook(
      {
        hmac: req.get('x-shopify-hmac-sha256'),
        topic: req.get('x-shopify-topic'),
        shopDomain: req.get('x-shopify-shop-domain'),
        webhookId: req.get('x-shopify-webhook-id'),
        apiVersion: req.get('x-shopify-api-version'),
        triggeredAt: req.get('x-shopify-triggered-at'),
      },
      req.rawBody,
    );

    res.status(200).json({ received: true, ...result });
  };

  disconnect = async (req: Request, res: Response) => {
    const result = await shopifyDisconnectService.disconnect(req.context.storeId!);
    res.status(200).json(result);
  };

  sync = async (req: Request, res: Response) => {
    const result = this.syncQueue
      ? await this.syncQueue.enqueue(req.context.storeId!)
      : await this.service.enqueueCatalogAndInventorySync(req.context.storeId!);
    res.status(202).json(result);
  };

  getSync = async (req: Request, res: Response) => {
    const { syncRunId } = shopifySyncRunParamsSchema.parse(req.params);
    const result = this.syncQueue
      ? await this.syncQueue.get(req.context.storeId!, syncRunId)
      : await this.service.getCatalogAndInventorySync(req.context.storeId!, syncRunId);
    res.status(200).json(result);
  };

  startOrderBackfill = async (req: Request, res: Response) => {
    const result = await this.service.startOrderHistoryBackfill(req.context.storeId!);
    res.status(202).json(result);
  };

  getOrderBackfill = async (req: Request, res: Response) => {
    const { syncRunId } = shopifyOrderBackfillParamsSchema.parse(req.params);
    const result = await this.service.getOrderHistoryBackfill(req.context.storeId!, syncRunId);
    res.status(200).json(result);
  };
}

export const shopifyController = new ShopifyController(shopifyService, shopifySyncQueueService);
