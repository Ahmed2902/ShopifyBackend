import type { Request, Response } from 'express';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { inventoryPlanningService } from './inventory-planning.service.js';
import { recommendationLifecycleService } from './recommendation-lifecycle.service.js';
import {
  intelligenceReadQuerySchema,
  inventoryModeUpdateSchema,
  inventoryPlanningUpdateSchema,
  recommendationLifecycleUpdateSchema,
} from './intelligence.schema.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from './intelligence-snapshot.read.service.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

function recommendationLimit(res: Response) {
  return Math.max(
    1,
    Number(res.locals.billing?.entitlements?.recommendationLimit ?? 10),
  );
}

export class IntelligenceController {
  constructor(
    private readonly service: IntelligenceService,
    private readonly snapshotReads: IntelligenceSnapshotReadService,
  ) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { fresh } = intelligenceReadQuerySchema.parse(req.query);
    const snapshot = await this.snapshotReads.read(storeId, { fresh });
    const recommendations = await recommendationLifecycleService.attach(
      storeId,
      snapshot.recommendations.slice(0, recommendationLimit(res)),
    );
    res.status(200).json({ ...snapshot, recommendations });
  };

  settings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getSettings(req.context.storeId!));
  };

  inventoryPlanning = async (req: Request, res: Response) => {
    res.status(200).json(await inventoryPlanningService.get(req.context.storeId!));
  };

  updateInventoryMode = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { mode } = inventoryModeUpdateSchema.parse(req.body);
    const result = await this.service.updateInventoryMode(storeId, mode);
    await invalidateStoreDecisionCaches(storeId);
    res.status(200).json(result);
  };

  updateInventoryPlanning = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const input = inventoryPlanningUpdateSchema.parse(req.body);
    const result = await inventoryPlanningService.update(storeId, input);
    await invalidateStoreDecisionCaches(storeId);
    res.status(200).json(result);
  };

  updateRecommendationLifecycle = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { occurrenceKey, state } = recommendationLifecycleUpdateSchema.parse(req.body);
    const snapshot = await this.snapshotReads.read(storeId, { fresh: false });
    const currentRecommendations = snapshot.recommendations.slice(0, recommendationLimit(res));
    const result = await recommendationLifecycleService.setState(
      storeId,
      occurrenceKey,
      state,
      currentRecommendations,
    );
    res.status(200).json(result);
  };
}

export const intelligenceController = new IntelligenceController(
  intelligenceService,
  intelligenceSnapshotReadService,
);