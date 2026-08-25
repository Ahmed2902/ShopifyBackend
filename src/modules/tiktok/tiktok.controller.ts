import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import {
  tiktokAdGroupListQuerySchema,
  tiktokAdListQuerySchema,
  tiktokAdParamsSchema,
  tiktokCampaignListQuerySchema,
} from './ads/tiktok-ads.schema.js';
import {
  tiktokCatalogItemsQuerySchema,
  tiktokCatalogParamsSchema,
} from './catalog/tiktok-catalog.schema.js';
import {
  tiktokInsightsListQuerySchema,
  tiktokInsightsSyncSchema,
} from './insights/tiktok-insights.schema.js';
import {
  tiktokCallbackSchema,
  tiktokConfigureAssetsSchema,
  tiktokConfigureCatalogsSchema,
} from './tiktok.schema.js';
import { tiktokService, type TikTokService } from './tiktok.service.js';
import {
  buildTikTokErrorRedirect,
  buildTikTokSuccessRedirect,
  toJsonSafe,
  verifyTikTokOAuthState,
} from './tiktok.utils.js';

export class TikTokController {
  constructor(private readonly service: TikTokService) {}

  startInstall = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.startOAuthInstall(req.context.userId!, req.context.storeId!));
  };

  completeInstall = async (req: Request, res: Response) => {
    const rawState = typeof req.query.state === 'string' ? req.query.state : undefined;
    const context = verifyTikTokOAuthState(rawState);

    if (typeof req.query.error === 'string') {
      res.redirect(303, buildTikTokErrorRedirect(context.storeId, 'TIKTOK_OAUTH_DENIED'));
      return;
    }

    try {
      const query = tiktokCallbackSchema.parse({
        auth_code: req.query.auth_code,
        code: req.query.code,
        state: rawState,
      });
      const result = await this.service.completeOAuthInstall(
        query.auth_code ?? query.code!,
        query.state,
      );
      res.redirect(303, buildTikTokSuccessRedirect(result.storeId));
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'TIKTOK_OAUTH_FAILED';
      res.redirect(303, buildTikTokErrorRedirect(context.storeId, code));
    }
  };

  status = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getStatus(req.context.storeId!));
  };

  assets = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.discoverAssets(req.context.storeId!));
  };

  configure = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.configureAssets(
        req.context.storeId!,
        tiktokConfigureAssetsSchema.parse(req.body),
      ),
    );
  };

  configureCatalogs = async (req: Request, res: Response) => {
    const { catalogIds } = tiktokConfigureCatalogsSchema.parse(req.body);
    res.status(200).json(await this.service.configureCatalogs(req.context.storeId!, catalogIds));
  };

  sync = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.syncAdsHierarchy(req.context.storeId!));
  };

  syncCatalogs = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.syncCatalogs(req.context.storeId!));
  };

  syncInsights = async (req: Request, res: Response) => {
    const { lookbackDays } = tiktokInsightsSyncSchema.parse(req.body ?? {});
    res.status(200).json(await this.service.syncInsights(req.context.storeId!, lookbackDays));
  };

  campaigns = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listCampaigns(
        req.context.storeId!,
        tiktokCampaignListQuerySchema.parse(req.query),
      ),
    );
  };

  adGroups = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listAdGroups(
        req.context.storeId!,
        tiktokAdGroupListQuerySchema.parse(req.query),
      ),
    );
  };

  ads = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listAds(req.context.storeId!, tiktokAdListQuerySchema.parse(req.query)),
    );
  };

  ad = async (req: Request, res: Response) => {
    const { adId } = tiktokAdParamsSchema.parse(req.params);
    res.status(200).json(toJsonSafe(await this.service.getAd(req.context.storeId!, adId)));
  };

  catalogs = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.listCatalogs(req.context.storeId!));
  };

  catalogItems = async (req: Request, res: Response) => {
    const { catalogId } = tiktokCatalogParamsSchema.parse(req.params);
    const { page, limit } = tiktokCatalogItemsQuerySchema.parse(req.query);
    res.status(200).json(
      await this.service.listCatalogItems(req.context.storeId!, catalogId, page, limit),
    );
  };

  insights = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.service.listInsights(
          req.context.storeId!,
          tiktokInsightsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };
}

export const tiktokController = new TikTokController(tiktokService);
