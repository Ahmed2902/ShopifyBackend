import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import {
  metaAdListQuerySchema,
  metaAdParamsSchema,
  metaAdSetListQuerySchema,
  metaCallbackSchema,
  metaCampaignListQuerySchema,
  metaCatalogItemsQuerySchema,
  metaCatalogParamsSchema,
  metaConfigureAssetsSchema,
  metaConfigureCatalogsSchema,
  metaInsightsListQuerySchema,
  metaInsightsSyncSchema,
} from './meta.schema.js';
import type { MetaService } from './meta.service.js';
import { buildMetaSuccessRedirect } from './meta.utils.js';

export class MetaController {
  constructor(private readonly service: MetaService) {}

  startInstall = async (req: Request, res: Response) => {
    const result = await this.service.startOAuthInstall(req.context.userId!, req.context.storeId!);
    res.status(200).json(result);
  };

  completeInstall = async (req: Request, res: Response) => {
    const providerError = typeof req.query.error === 'string' ? req.query.error : null;
    if (providerError) {
      const description =
        typeof req.query.error_description === 'string'
          ? req.query.error_description
          : 'Meta authorization was not completed';
      throw new AppError(description, 400, 'META_OAUTH_DENIED');
    }

    const query = metaCallbackSchema.parse({ code: req.query.code, state: req.query.state });
    const result = await this.service.completeOAuthInstall(query.code, query.state);
    res.redirect(303, buildMetaSuccessRedirect(result.storeId));
  };

  status = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getStatus(req.context.storeId!));
  };

  assets = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.discoverAssets(req.context.storeId!));
  };

  configure = async (req: Request, res: Response) => {
    const input = metaConfigureAssetsSchema.parse(req.body);
    res.status(200).json(await this.service.configureAssets(req.context.storeId!, input));
  };

  configureCatalogs = async (req: Request, res: Response) => {
    const input = metaConfigureCatalogsSchema.parse(req.body);
    res.status(200).json(await this.service.configureCatalogs(req.context.storeId!, input.catalogIds));
  };

  sync = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.syncAdsHierarchy(req.context.storeId!));
  };

  syncCatalogs = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.syncCatalogs(req.context.storeId!));
  };

  syncInsights = async (req: Request, res: Response) => {
    const input = metaInsightsSyncSchema.parse(req.body ?? {});
    res.status(200).json(await this.service.syncInsights(req.context.storeId!, input.lookbackDays));
  };

  adAccounts = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.listAdAccounts(req.context.storeId!));
  };

  campaigns = async (req: Request, res: Response) => {
    const input = metaCampaignListQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listCampaigns(req.context.storeId!, input));
  };

  adSets = async (req: Request, res: Response) => {
    const input = metaAdSetListQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listAdSets(req.context.storeId!, input));
  };

  ads = async (req: Request, res: Response) => {
    const input = metaAdListQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listAds(req.context.storeId!, input));
  };

  ad = async (req: Request, res: Response) => {
    const { adId } = metaAdParamsSchema.parse(req.params);
    res.status(200).json(await this.service.getAd(req.context.storeId!, adId));
  };

  catalogs = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.listCatalogs(req.context.storeId!));
  };

  catalogItems = async (req: Request, res: Response) => {
    const { catalogId } = metaCatalogParamsSchema.parse(req.params);
    const { page, limit } = metaCatalogItemsQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listCatalogItems(req.context.storeId!, catalogId, page, limit));
  };

  insights = async (req: Request, res: Response) => {
    const input = metaInsightsListQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listInsights(req.context.storeId!, input));
  };
}
