import { logger } from '../../lib/logger.js';
import type { ReconciliationService } from './reconciliation.service.js';

const POLL_INTERVAL_MS = 60_000;
const BATCH_SIZE = 10;

export class ReconciliationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(private readonly service: ReconciliationService) {}

  start(): void {
    if (this.timer || this.stopping) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const result = await this.service.processDue(BATCH_SIZE);
      if (result.claimed > 0) logger.info(result, 'Processed scheduled reconciliation batch');
    } catch (error) {
      logger.error({ err: error }, 'Scheduled reconciliation worker failed');
    } finally {
      this.running = false;
    }
  }
}
