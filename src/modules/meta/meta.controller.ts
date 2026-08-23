import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { metaCallbackSchema, metaConfigureAssetsSchema } from './meta.schema.js';
import type { MetaService } from './meta.service.js';
import { buildMetaSuccessRedirect } from './meta.utils.js';

export class MetaController {
  constructor(private readonly service: MetaService) {}

  startInstall = async (req: Request, res: Response) => {
    const result = await this.service.startOAuthInstall(
      req.context.userId!,
      req.context.storeId!,
    );
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

    const query = metaCallbackSchema.parse({
      code: req.query.code,
      state: req.query.state,
    });
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
}
