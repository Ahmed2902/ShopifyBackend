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
import { metaService, type MetaService } from './meta.service.js';
import { buildMetaSuccessRedirect } from './meta.utils.js';

export class MetaController {
  constructor(private readonly service: MetaService) {}

  startInstall = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.startOAuthInstall(req.context.userId!, req.context.storeId!),
    );
  };

  completeInstall = async (req: Request, res: Response) => {
    if (typeof req.query.error === 'string') {
      throw new AppError(
        typeof req.query.error_description === 'string'
          ? req.query.error_description
          : 'Meta authorization was not completed',
        400,
        'META_OAUTH_DENIED',
      );
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
    res.status(200).json(
      await this.service.configureAssets(
        req.context.storeId!,
        metaConfigureAssetsSchema.parse(req.body),
      ),
    );
  };

  configureCatalogs = async (req: Request, res: Response) => {
    const { catalogIds } = metaConfigureCatalogsSchema.parse(req.body);
    res.status(200).json(await this.service.configureCatalogs(req.context.storeId!, catalogIds));
  };

  sync = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.syncAdsHierarchy(req.context.storeId!));
  };

  syncCatalogs = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.syncCatalogs(req.context.storeId!));
  };

  syncInsights = async (req: Request, res: Response) => {
    const { lookbackDays } = metaInsightsSyncSchema.parse(req.body ?? {});
    res.status(200).json(await this.service.syncInsights(req.context.storeId!, lookbackDays));
  };

  adAccounts = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.listAdAccounts(req.context.storeId!));
  };

  campaigns = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listCampaigns(
        req.context.storeId!,
        metaCampaignListQuerySchema.parse(req.query),
      ),
    );
  };

  adSets = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listAdSets(req.context.storeId!, metaAdSetListQuerySchema.parse(req.query)),
    );
  };

  ads = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listAds(req.context.storeId!, metaAdListQuerySchema.parse(req.query)),
    );
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
    res.status(200).json(
      await this.service.listCatalogItems(req.context.storeId!, catalogId, page, limit),
    );
  };

  insights = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listInsights(
        req.context.storeId!,
        metaInsightsListQuerySchema.parse(req.query),
      ),
    );
  };
}

export const metaController = new MetaController(metaService);
