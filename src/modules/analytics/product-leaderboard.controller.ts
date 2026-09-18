import type { Request, Response } from 'express';
import { z } from 'zod';
import { toJsonSafe } from '../meta/meta.utils.js';
import { analyticsRangeQuerySchema } from './analytics.schema.js';
import { productLeaderboardService } from './product-leaderboard.service.js';

const productLeaderboardQuerySchema = analyticsRangeQuerySchema.and(
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);

export class ProductLeaderboardController {
  read = async (req: Request, res: Response) => {
    const query = productLeaderboardQuerySchema.parse(req.query);
    res.status(200).json(
      toJsonSafe(await productLeaderboardService.read(req.context.storeId!, query)),
    );
  };
}

export const productLeaderboardController = new ProductLeaderboardController();
