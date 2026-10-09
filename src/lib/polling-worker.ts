import { logger } from './logger.js';

export class PollingWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private startedAt: number | null = null;
  private runningSince: number | null = null;
  private lastSucceededAt: number | null = null;
  private failures = 0;

  health(now = Date.now()) {
    const deadline = Math.max(120_000, this.intervalMs * 3);
    return {
      name: this.errorMessage,
      intervalMs: this.intervalMs,
      lastSucceededAt: this.lastSucceededAt,
      failures: this.failures,
      healthy:
        !this.stopping &&
        this.startedAt !== null &&
        (this.runningSince !== null
          ? now - this.runningSince < 900_000
          : this.lastSucceededAt === null
            ? now - this.startedAt < 180_000
            : now - this.lastSucceededAt < deadline),
    };
  }

  constructor(
    private readonly intervalMs: number,
    private readonly task: () => Promise<void>,
    private readonly errorMessage: string,
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    this.startedAt = Date.now();
    void this.tick();
    // Keep the interval referenced. In a dedicated worker process these timers are the
    // long-lived runtime itself; unref() would allow Node to exit as soon as startup finishes.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    this.runningSince = Date.now();
    try {
      await this.task();
      this.lastSucceededAt = Date.now();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      logger.error({ err: error }, this.errorMessage);
    } finally {
      this.running = false;
      this.runningSince = null;
    }
  }
}
