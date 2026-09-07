import type { Request, Response } from 'express';
import { CachedReadCoordinator, RedisJsonCache } from '../../lib/redis-json-cache.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import { tiktokMonitorQuerySchema } from './tiktok-monitor.schema.js';
import { tiktokMonitorService, type TikTokMonitorService } from './tiktok-monitor.service.js';

const TIKTOK_MONITOR_CACHE_TTL_SECONDS = 30;
const tiktokMonitorReads = new CachedReadCoordinator(
  new RedisJsonCache('analytics:tiktok-monitor:v1', TIKTOK_MONITOR_CACHE_TTL_SECONDS),
  250,
);

export class TikTokMonitorController {
  constructor(private readonly service: TikTokMonitorService = tiktokMonitorService) {}

  read = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = tiktokMonitorQuerySchema.parse(req.query);
    const key = [storeId, query.days, query.level, query.page, query.limit].join(':');
    const payload = await tiktokMonitorReads.run(
      key,
      async () => toJsonSafe(await this.service.read(storeId, query)),
      { fresh: query.fresh },
    );
    res.status(200).json(payload);
  };
}

export const tiktokMonitorController = new TikTokMonitorController();
