import type { Request, Response } from 'express';
import { shopifyOrderBackfillParamsSchema } from './shopify-order.schema.js';
import { shopifyCallbackSchema, shopifyInstallSchema } from './shopify.schema.js';
import type { ShopifyService } from './shopify.service.js';
import {
  buildShopifySuccessRedirect,
  clearShopifyOAuthCookie,
  setShopifyOAuthCookie,
  SHOPIFY_OAUTH_COOKIE_NAME,
  verifyShopifyCallbackTimestamp,
  verifyShopifyOAuthHmac,
} from './shopify.utils.js';

export class ShopifyController {
  constructor(private readonly service: ShopifyService) {}

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

  sync = async (req: Request, res: Response) => {
    const result = await this.service.syncStoreData(req.context.storeId!);
    res.status(200).json(result);
  };

  startOrderBackfill = async (req: Request, res: Response) => {
    const result = await this.service.startOrderHistoryBackfill(req.context.storeId!);
    res.status(202).json(result);
  };

  getOrderBackfill = async (req: Request, res: Response) => {
    const { syncRunId } = shopifyOrderBackfillParamsSchema.parse(req.params);
    const result = await this.service.getOrderHistoryBackfill(
      req.context.storeId!,
      syncRunId,
    );
    res.status(200).json(result);
  };
}
