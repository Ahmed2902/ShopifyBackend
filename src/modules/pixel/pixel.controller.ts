import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { logger } from '../../lib/logger.js';
import { pixelDebugBatchSchema, pixelIngestBatchSchema } from './pixel.schema.js';
import { pixelService, type PixelService } from './pixel.service.js';

function parseCollectorBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppError('Pixel collector body must be valid JSON', 400, 'PIXEL_INVALID_JSON');
  }
}

function collectorRejectionCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof ZodError) return 'VALIDATION_ERROR';
  return 'PIXEL_COLLECTOR_ERROR';
}

function collectorReachability(collectorUrl: string | null) {
  if (!collectorUrl) {
    return {
      storefrontReachable: false,
      warning: 'No Pixel collector URL is configured. Set APP_URL or PIXEL_COLLECTOR_URL before installing the Pixel.',
    };
  }
  try {
    const url = new URL(collectorUrl);
    const localHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
    const privateIpv4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
    if (url.protocol !== 'https:' || localHost || privateIpv4) {
      return {
        storefrontReachable: false,
        warning: 'Shopify storefront Web Pixels need a public HTTPS collector. Localhost, private-network and HTTP collector URLs cannot receive real storefront traffic.',
      };
    }
    return { storefrontReachable: true, warning: null };
  } catch {
    return { storefrontReachable: false, warning: 'The configured Pixel collector URL is invalid.' };
  }
}

export class PixelController {
  constructor(private readonly service: PixelService) {}

  ingest = async (req: Request, res: Response) => {
    try {
      const input = pixelIngestBatchSchema.parse(parseCollectorBody(req.body));
      const result = await this.service.ingest(input);
      logger.debug(
        {
          received: result.received,
          persisted: result.persisted,
          duplicates: result.duplicates,
          suppressedForConsent: result.suppressedForConsent,
        },
        'Stride Pixel collector accepted batch',
      );
      res.status(200).json(result);
    } catch (error) {
      logger.warn(
        { code: collectorRejectionCode(error) },
        'Stride Pixel collector rejected batch',
      );
      throw error;
    }
  };

  status = async (req: Request, res: Response) => {
    const status = await this.service.getStatus(req.context.storeId!);
    const reachability = collectorReachability(status.collectorUrl);
    res.status(200).json({
      ...status,
      storefrontReachable: reachability.storefrontReachable,
      collectorWarning: reachability.warning,
    });
  };

  install = async (req: Request, res: Response) => {
    const result = await this.service.installShopifyPixel(req.context.storeId!);
    const reachability = collectorReachability(result.collectorUrl);
    res.status(200).json({
      ...result,
      storefrontReachable: reachability.storefrontReachable,
      collectorWarning: reachability.warning,
    });
  };

  debugValidate = async (req: Request, res: Response) => {
    const input = pixelDebugBatchSchema.parse(req.body);
    res.status(200).json(this.service.validateDebug(input));
  };
}

export const pixelController = new PixelController(pixelService);
