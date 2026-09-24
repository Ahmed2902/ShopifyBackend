import type { Request, Response } from 'express';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { limitRecommendations, recommendationLimit } from './recommendation-entitlement.js';
import {
  recommendationLifecycleService,
  type RecommendationLifecycleService,
} from './recommendation-lifecycle.service.js';
import {
  recommendationOccurrenceValidationService,
  type RecommendationOccurrenceValidationService,
} from './recommendation-occurrence-validation.service.js';
import {
  intelligenceReadQuerySchema,
  inventoryModeUpdateSchema,
  recommendationLifecycleUpdateSchema,
} from './intelligence.schema.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from './intelligence-snapshot.read.service.js';
import { intelligenceRuntimeService } from './intelligence.runtime.js';
import type { IntelligenceService } from './intelligence.service.js';

export class IntelligenceController {
  constructor(
    private readonly service: IntelligenceService,
    private readonly snapshotReads: IntelligenceSnapshotReadService,
    private readonly occurrenceValidation: RecommendationOccurrenceValidationService =
      recommendationOccurrenceValidationService,
    private readonly lifecycle: RecommendationLifecycleService = recommendationLifecycleService,
  ) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { fresh } = intelligenceReadQuerySchema.parse(req.query);
    const snapshot = await this.snapshotReads.read(storeId, { fresh });
    const recommendations = await this.lifecycle.attach(
      storeId,
      limitRecommendations(res, snapshot.recommendations),
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

    // Lifecycle writes are accepted only for recommendation occurrences the server can reproduce
    // under the current Store entitlement. Unified occurrence handles carry the exact issuing read
    // scope while persistence continues to use the canonical occurrence key.
    const validation = await this.occurrenceValidation.currentRecommendations(
      storeId,
      occurrenceKey,
      recommendationLimit(res),
    );
    const result = await this.lifecycle.setState(
      storeId,
      validation.canonicalOccurrenceKey,
      state,
      validation.recommendations,
    );
    // Unified decisions are cached with lifecycle state attached. Advance all Store decision-cache
    // generations only after persistence succeeds so the next normal read reflects the mutation.
    await invalidateStoreDecisionCaches(storeId);
    res.status(200).json({
      ...result,
      // Return the same public handle the caller submitted. The DB row intentionally stores the
      // canonical key so lifecycle state remains shared across equivalent recommendation reads.
      occurrenceKey,
    });
  };
}

export const intelligenceController = new IntelligenceController(
  intelligenceRuntimeService,
  intelligenceSnapshotReadService,
);
