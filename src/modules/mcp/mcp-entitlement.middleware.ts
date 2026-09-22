import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { billingService, type V1AdProvider } from '../billing/billing.service.js';

const PAID_MEDIA_SEARCH_TYPES = new Set(['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE']);

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

function selectedProvider(plan: Record<string, unknown>): V1AdProvider | null {
  const value = plan.essentialsAdProvider;
  return value === 'META' || value === 'TIKTOK' ? value : null;
}

function maxAdChannels(plan: Record<string, unknown>): number | null {
  const entitlements = plan.entitlements;
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) return 0;
  const value = (entitlements as Record<string, unknown>).maxAdChannels;
  return value === null ? null : typeof value === 'number' ? value : 0;
}

function requireProvider(plan: Record<string, unknown>, provider: V1AdProvider) {
  if (maxAdChannels(plan) === null) return;
  const selected = selectedProvider(plan);
  if (!selected) {
    throw new AppError(
      'Essentials requires selecting one advertising channel before MCP can read paid-media data.',
      409,
      'PLAN_CHANNEL_SELECTION_REQUIRED',
    );
  }
  if (selected !== provider) {
    throw new AppError(
      'This advertising channel is not included in the store’s current Essentials selection.',
      403,
      'PLAN_AD_CHANNEL_LIMIT',
      { selectedProvider: selected, requestedProvider: provider },
    );
  }
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
      const provider = call.args.provider;
      if (provider === 'META' || provider === 'TIKTOK') requireProvider(plan, provider);
    }

    if (call.name === 'stride_get_product_ads') {
      requireProvider(plan, 'META');
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
