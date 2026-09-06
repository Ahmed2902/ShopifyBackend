import { logger } from './logger.js';

export class PollingWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly intervalMs: number,
    private readonly task: () => Promise<void>,
    private readonly errorMessage: string,
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
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
    try {
      await this.task();
    } catch (error) {
      logger.error({ err: error }, this.errorMessage);
    } finally {
      this.running = false;
    }
  }
}
