import type { Request, Response } from 'express';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { billingService, type BillingService } from '../billing/billing.service.js';
import {
  intelligenceReadQuerySchema,
  inventoryModeUpdateSchema,
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
    private readonly billing: BillingService = billingService,
  ) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { fresh } = intelligenceReadQuerySchema.parse(req.query);
    const [snapshot, subscription] = await Promise.all([
      this.snapshotReads.read(storeId, { fresh }),
      this.billing.read(storeId),
    ]);
    res.status(200).json({
      ...snapshot,
      recommendations: snapshot.recommendations.slice(0, subscription.entitlements.recommendationLimit),
      recommendationAccess: {
        returned: Math.min(snapshot.recommendations.length, subscription.entitlements.recommendationLimit),
        totalComputed: snapshot.recommendations.length,
        limit: subscription.entitlements.recommendationLimit,
        effectivePlan: subscription.effectivePlan,
      },
    });
  };

  settings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getSettings(req.context.storeId!));
  };

  updateInventoryMode = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { mode } = inventoryModeUpdateSchema.parse(req.body);
    const result = await this.service.updateInventoryMode(storeId, mode);
    await invalidateStoreDecisionCaches(storeId);
    res.status(200).json(result);
  };
}

export const intelligenceController = new IntelligenceController(
  intelligenceService,
  intelligenceSnapshotReadService,
);
