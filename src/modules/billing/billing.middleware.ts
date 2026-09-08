import type { NextFunction, Request, Response } from 'express';
import { billingService, type V1AdProvider, type V1Entitlement } from './billing.service.js';

export async function requireActiveSubscription(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    await billingService.requireActive(req.context.storeId!);
    next();
  } catch (error) {
    next(error);
  }
}

export function requireBillingEntitlement(entitlement: V1Entitlement) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await billingService.requireEntitlement(req.context.storeId!, entitlement);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAdProviderEntitlement(provider: V1AdProvider) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await billingService.requireAdProvider(req.context.storeId!, provider);
      next();
    } catch (error) {
      next(error);
    }
  };
}
