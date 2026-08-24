import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { integrationService } from '../integrations/integration.service.js';
import { TikTokApiService } from './shared/tiktok-api.service.js';
import { TikTokAuthService } from './shared/tiktok-auth.service.js';
import {
  tiktokAdGroupListQuerySchema,
  tiktokAdListQuerySchema,
  tiktokAdParamsSchema,
  tiktokCallbackSchema,
  tiktokCampaignListQuerySchema,
  tiktokCatalogItemsQuerySchema,
  tiktokCatalogParamsSchema,
  tiktokConfigureAssetsSchema,
  tiktokConfigureCatalogsSchema,
  tiktokInsightsListQuerySchema,
  tiktokInsightsSyncSchema,
  tiktokManualAdMappingSchema,
  tiktokManualCatalogMappingSchema,
} from './tiktok.schema.js';
import { TikTokRepository } from './tiktok.repository.js';
import { TikTokService } from './tiktok.service.js';
import {
  buildTikTokSuccessRedirect,
  toJsonSafe,
  verifyTikTokOAuthState,
} from './tiktok.utils.js';

export class TikTokController {
  constructor(private readonly service: TikTokService) {}

  startInstall = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(await this.service.startOAuthInstall(req.context.userId!, req.context.storeId!));
  };

  completeInstall = async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (typeof req.query.error === 'string') {
      verifyTikTokOAuthState(state);
      throw new AppError(
        typeof req.query.error_description === 'string'
          ? req.query.error_description
          : 'TikTok authorization was not completed',
        400,
        'TIKTOK_OAUTH_DENIED',
      );
    }
    const query = tiktokCallbackSchema.parse({
      auth_code: req.query.auth_code,
      code: req.query.code,
      state: req.query.state,
    });
    const result = await this.service.completeOAuthInstall(
      query.auth_code ?? query.code!,
      query.state,
    );
    res.redirect(303, buildTikTokSuccessRedirect(result.storeId));
  };

  status = async (req: Request, res: Response) =>
    res.status(200).json(await this.service.getStatus(req.context.storeId!));

  assets = async (req: Request, res: Response) =>
    res.status(200).json(await this.service.discoverAssets(req.context.storeId!));

  configure = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(
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

  sync = async (req: Request, res: Response) =>
    res.status(200).json(await this.service.syncAdsHierarchy(req.context.storeId!));

  syncCatalogs = async (req: Request, res: Response) =>
    res.status(200).json(await this.service.syncCatalogs(req.context.storeId!));

  syncInsights = async (req: Request, res: Response) => {
    const { lookbackDays } = tiktokInsightsSyncSchema.parse(req.body ?? {});
    res
      .status(200)
      .json(await this.service.syncInsights(req.context.storeId!, lookbackDays));
  };

  campaigns = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(
        await this.service.listCampaigns(
          req.context.storeId!,
          tiktokCampaignListQuerySchema.parse(req.query),
        ),
      );
  };

  adGroups = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(
        await this.service.listAdGroups(
          req.context.storeId!,
          tiktokAdGroupListQuerySchema.parse(req.query),
        ),
      );
  };

  ads = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(
        await this.service.listAds(
          req.context.storeId!,
          tiktokAdListQuerySchema.parse(req.query),
        ),
      );
  };

  ad = async (req: Request, res: Response) => {
    const { adId } = tiktokAdParamsSchema.parse(req.params);
    res.status(200).json(toJsonSafe(await this.service.getAd(req.context.storeId!, adId)));
  };

  catalogs = async (req: Request, res: Response) =>
    res.status(200).json(await this.service.listCatalogs(req.context.storeId!));

  catalogItems = async (req: Request, res: Response) => {
    const { catalogId } = tiktokCatalogParamsSchema.parse(req.params);
    const { page, limit } = tiktokCatalogItemsQuerySchema.parse(req.query);
    res
      .status(200)
      .json(await this.service.listCatalogItems(req.context.storeId!, catalogId, page, limit));
  };

  insights = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(
        toJsonSafe(
          await this.service.listInsights(
            req.context.storeId!,
            tiktokInsightsListQuerySchema.parse(req.query),
          ),
        ),
      );
  };

  resolveMappings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.resolveMappings(req.context.storeId!));
  };

  replaceAdMapping = async (req: Request, res: Response) => {
    const { adId } = tiktokAdParamsSchema.parse(req.params);
    const input = tiktokManualAdMappingSchema.parse(req.body);
    res
      .status(200)
      .json(
        await this.service.setManualAdMapping(
          req.context.storeId!,
          adId,
          input.productId,
          input.variantId ?? null,
        ),
      );
  };

  replaceCatalogItemMapping = async (req: Request, res: Response) => {
    const catalogItemId = req.params.catalogItemId;
    if (!catalogItemId) {
      throw new AppError('Catalog item ID is required', 400, 'INVALID_CATALOG_ITEM_ID');
    }
    const { variantId } = tiktokManualCatalogMappingSchema.parse(req.body);
    res
      .status(200)
      .json(
        await this.service.setManualCatalogMapping(
          req.context.storeId!,
          catalogItemId,
          variantId,
        ),
      );
  };
}

const tiktokRepository = new TikTokRepository();
const tiktokApiService = new TikTokApiService();
const tiktokAuthService = new TikTokAuthService(tiktokRepository, tiktokApiService);

export const tiktokService = new TikTokService(
  tiktokRepository,
  tiktokAuthService,
  tiktokApiService,
  integrationService,
);
export const tiktokController = new TikTokController(tiktokService);
