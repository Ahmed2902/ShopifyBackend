import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsEntityParamsSchema,
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
} from './analytics.schema.js';
import { analyticsWorkspace, type AnalyticsWorkspace } from './analytics.workspace.js';

function entityId(req: Request, key: string): string {
  return analyticsEntityParamsSchema.parse({ entityId: req.params[key] }).entityId;
}

export class AnalyticsController {
  constructor(private readonly workspace: AnalyticsWorkspace) {}

  overview = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.overview(
          req.context.storeId!,
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  products = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.products(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  product = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.product(
          req.context.storeId!,
          entityId(req, 'productId'),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  collections = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.collections(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  customers = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.customers(
          req.context.storeId!,
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  inventory = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.inventory(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  advertising = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.advertising(
          req.context.storeId!,
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  campaigns = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.campaigns(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  campaign = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.campaign(
          req.context.storeId!,
          entityId(req, 'campaignId'),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  adSets = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.adSets(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  adSet = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.adSet(
          req.context.storeId!,
          entityId(req, 'adSetId'),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  ads = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.ads(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  ad = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.ad(
          req.context.storeId!,
          entityId(req, 'adId'),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  creatives = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.creatives(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  creative = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.creative(
          req.context.storeId!,
          entityId(req, 'creativeId'),
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };
}

export const analyticsController = new AnalyticsController(analyticsWorkspace);
