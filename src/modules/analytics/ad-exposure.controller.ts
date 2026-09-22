import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import { AdExposureRepository } from './ad-exposure.repository.js';
import { AdExposureWorkspace, adExposureWorkspace } from './ad-exposure.workspace.js';
import { AnalyticsRepository } from './analytics.repository.js';
import {
  analyticsEntityParamsSchema,
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
  type AnalyticsRangeQuery,
} from './analytics.schema.js';
import { CanonicalAnalyticsRepository } from './canonical-analytics.repository.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;

export function scopeSelectedMetaAccount(store: StoreContext, accountId: string): StoreContext {
  const configuredAccountIds = store.metaConnection?.selectedAdAccountIds ?? [];
  if (!store.metaConnection || !configuredAccountIds.includes(accountId)) {
    throw new AppError(
      'Meta ad account is not selected for this store',
      400,
      'META_AD_ACCOUNT_NOT_SELECTED',
    );
  }
  return {
    ...store,
    metaConnection: {
      ...store.metaConnection,
      selectedAdAccountIds: [accountId],
    },
  };
}

class AccountScopedAnalyticsRepository extends AnalyticsRepository {
  constructor(private readonly accountId: string) {
    super();
  }

  override async getStoreContext(storeId: string) {
    const store = await super.getStoreContext(storeId);
    return store ? scopeSelectedMetaAccount(store, this.accountId) : store;
  }
}

export class AdExposureController {
  constructor(private readonly workspace: AdExposureWorkspace) {}

  private workspaceFor(query: AnalyticsRangeQuery): AdExposureWorkspace {
    if (!query.accountId) return this.workspace;
    return new AdExposureWorkspace(
      new AccountScopedAnalyticsRepository(query.accountId),
      new AdExposureRepository(),
      new CanonicalAnalyticsRepository(),
    );
  }

  list = async (req: Request, res: Response) => {
    const query = analyticsListQuerySchema.parse(req.query);
    res.status(200).json(
      toJsonSafe(await this.workspaceFor(query).list(req.context.storeId!, query)),
    );
  };

  detail = async (req: Request, res: Response) => {
    const adId = analyticsEntityParamsSchema.parse({ entityId: req.params.adId }).entityId;
    const query = analyticsRangeQuerySchema.parse(req.query);
    res.status(200).json(
      toJsonSafe(await this.workspaceFor(query).detail(req.context.storeId!, adId, query)),
    );
  };
}

export const adExposureController = new AdExposureController(adExposureWorkspace);
