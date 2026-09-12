import type { Request, Response } from 'express';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { recommendationLifecycleService } from './recommendation-lifecycle.service.js';
import {
  intelligenceReadQuerySchema,
  inventoryModeUpdateSchema,
  recommendationLifecycleUpdateSchema,
} from './intelligence.schema.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from './intelligence-snapshot.read.service.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

export class IntelligenceController {
  constructor(
    private readonly service: IntelligenceService,
    private readonly snapshotReads: IntelligenceSnapshotReadService,
  ) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { fresh } = intelligenceReadQuerySchema.parse(req.query);
    const snapshot = await this.snapshotReads.read(storeId, { fresh });
    const recommendationLimit = Math.max(
      1,
      Number(res.locals.billing?.entitlements?.recommendationLimit ?? 10),
    );
    const recommendations = await recommendationLifecycleService.attach(
      storeId,
      snapshot.recommendations.slice(0, recommendationLimit),
    );
    res.status(200).json({
      ...snapshot,
      recommendations,
    });
  };

  settings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getSettings(req.context.storeId!));
  };

  updateInventoryMode = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { mode } = inventoryModeUpdateSchema.parse(req.body);
    const result = await this.service.updateInventoryMode(storeId, mode);
    // Invalidate both decision surfaces only after the Store setting is committed.
    await invalidateStoreDecisionCaches(storeId);
    res.status(200).json(result);
  };

  updateRecommendationLifecycle = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { occurrenceKey, state } = recommendationLifecycleUpdateSchema.parse(req.body);
    const result = await recommendationLifecycleService.setState(storeId, occurrenceKey, state);
    res.status(200).json(result);
  };
}

export const intelligenceController = new IntelligenceController(
  intelligenceService,
  intelligenceSnapshotReadService,
);
