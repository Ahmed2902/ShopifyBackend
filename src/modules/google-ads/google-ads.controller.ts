import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { googleAdsMappingService } from './google-ads-mapping.service.js';
import { GoogleAdsRepository } from './google-ads.repository.js';
import {
  googleAdsCallbackSchema,
  googleAdsConfigureSchema,
  googleAdsSyncSchema,
} from './google-ads.schema.js';
import { GoogleAdsService } from './google-ads.service.js';
import {
  buildGoogleAdsErrorRedirect,
  buildGoogleAdsSuccessRedirect,
  verifyGoogleAdsOAuthState,
} from './google-ads.utils.js';
import { GoogleAdsApiService } from './shared/google-ads-api.service.js';
import { GoogleAdsAuthService } from './shared/google-ads-auth.service.js';

const repository = new GoogleAdsRepository();
const api = new GoogleAdsApiService();
const auth = new GoogleAdsAuthService(repository, api);
export const googleAdsService = new GoogleAdsService(repository, auth, api);

export class GoogleAdsController {
  startInstall = async (req: Request, res: Response) => {
    res
      .status(200)
      .json(await googleAdsService.startOAuthInstall(req.context.userId!, req.context.storeId!));
  };

  completeInstall = async (req: Request, res: Response) => {
    let storeId = '';
    try {
      const state = verifyGoogleAdsOAuthState(req.query.state);
      storeId = state.storeId;
      if (typeof req.query.error === 'string') {
        res.redirect(303, buildGoogleAdsErrorRedirect(storeId, 'GOOGLE_ADS_OAUTH_DENIED'));
        return;
      }
      const query = googleAdsCallbackSchema.parse(req.query);
      const result = await googleAdsService.completeOAuthInstall(query.code, query.state);
      res.redirect(303, buildGoogleAdsSuccessRedirect(result.storeId));
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'GOOGLE_ADS_OAUTH_FAILED';
      if (storeId) {
        res.redirect(303, buildGoogleAdsErrorRedirect(storeId, code));
        return;
      }
      throw error;
    }
  };

  status = async (req: Request, res: Response) => {
    res.status(200).json(await googleAdsService.getStatus(req.context.storeId!));
  };

  customers = async (req: Request, res: Response) => {
    const discovery = await googleAdsService.discoverCustomers(req.context.storeId!);
    const persisted = await repository.listCustomers(req.context.storeId!);
    res.status(200).json({
      customers: persisted.map((customer) => ({
        customerId: customer.customerId,
        loginCustomerId: customer.loginCustomerId,
        descriptiveName: customer.descriptiveName,
        status: customer.status,
        currencyCode: customer.currencyCode,
        timeZone: customer.timeZone,
        manager: customer.manager,
        testAccount: customer.testAccount,
        level: customer.level,
        parentCustomerId: customer.parentCustomerId,
      })),
      permissions: discovery.permissions,
    });
  };

  configure = async (req: Request, res: Response) => {
    const { customerIds } = googleAdsConfigureSchema.parse(req.body);
    res.status(200).json(await googleAdsService.configureCustomers(req.context.storeId!, customerIds));
  };

  sync = async (req: Request, res: Response) => {
    const { mode } = googleAdsSyncSchema.parse(req.body ?? {});
    const sync = await googleAdsService.sync(req.context.storeId!, mode);
    const mappings = await googleAdsMappingService.projectDeterministicFinalUrls(req.context.storeId!);
    res.status(200).json({ ...sync, mappings });
  };

  disconnect = async (req: Request, res: Response) => {
    res.status(200).json(await auth.disconnect(req.context.storeId!));
  };
}

export const googleAdsController = new GoogleAdsController();
