import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { unifiedAdvertisingScopeService } from '../advertising/unified-advertising-scope.service.js';
import { billingService, type V1AdProvider } from '../billing/billing.service.js';

const PAID_MEDIA_SEARCH_TYPES = new Set(['CAMPAIGN', 'GROUP', 'AD', 'CREATIVE']);
const V1_AD_PROVIDERS = new Set<V1AdProvider>(['META', 'TIKTOK', 'GOOGLE_ADS']);

function toolCall(req: Request) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return null;
  const body = req.body as Record<string, unknown>;
  if (body.method !== 'tools/call') return null;
  const params = body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const args = record.arguments;
  return {
    name: typeof record.name === 'string' ? record.name : '',
    args:
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
  };
}

function provider(value: unknown): V1AdProvider | null {
  return typeof value === 'string' && V1_AD_PROVIDERS.has(value as V1AdProvider)
    ? (value as V1AdProvider)
    : null;
}

function maxAdChannels(plan: Record<string, unknown>): number | null {
  const entitlements = plan.entitlements;
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) return 0;
  const value = (entitlements as Record<string, unknown>).maxAdChannels;
  return value === null ? null : typeof value === 'number' ? value : 0;
}

export async function requireMcpToolEntitlement(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const call = toolCall(req);
    if (!call) return next();
    const storeId = req.context.storeId!;
    const plan = (res.locals.billing ?? (await billingService.requireActive(storeId))) as Record<
      string,
      unknown
    >;

    if (call.name === 'stride_get_paid_media') {
      const requestedProvider = provider(call.args.provider);
      if (requestedProvider) {
        await billingService.requireAdProviderReadOnly(storeId, requestedProvider);
      }
    }

    if (call.name === 'stride_get_product_ads') {
      const requested = call.args.provider;
      const requestedProvider = provider(requested);
      if (requested === undefined || requested === 'ALL' || requestedProvider) {
        await unifiedAdvertisingScopeService.resolve({
          storeId,
          provider: requestedProvider ?? 'ALL',
        });
      }
    }

    if (call.name === 'stride_get_attribution') {
      const surface = call.args.surface;
      if (surface === 'paths' || surface === 'mappings') {
        await billingService.requireEntitlement(storeId, 'ADVANCED_ATTRIBUTION');
      }
    }

    if (call.name === 'stride_search' && maxAdChannels(plan) !== null) {
      const types = Array.isArray(call.args.entityTypes)
        ? call.args.entityTypes.filter((value): value is string => typeof value === 'string')
        : null;
      const searchesPaidMedia = !types || types.some((type) => PAID_MEDIA_SEARCH_TYPES.has(type));
      if (searchesPaidMedia) {
        throw new AppError(
          'On Essentials, MCP search must be scoped to non-paid-media entity types. Use stride_get_paid_media with the selected channel for paid-media lookup.',
          403,
          'PLAN_AD_CHANNEL_LIMIT',
        );
      }
    }

    return next();
  } catch (error) {
    return next(error);
  }
}
