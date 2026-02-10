import { Executor } from '../executor/interface';
import { Logger } from '../logging/logger';

const logger = new Logger('health-checker');

export class HealthChecker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;

  constructor(
    private executor: Executor,
    checkIntervalMs = 60000
  ) {
    this.checkIntervalMs = checkIntervalMs;
  }

  start(): void {
    logger.info('Starting health checker', { intervalMs: this.checkIntervalMs });

    this.interval = setInterval(async () => {
      await this.checkHealth();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async checkHealth(): Promise<void> {
    const healthy = await this.executor.healthCheck();

    if (healthy) {
      logger.info('Executor health check passed');
    } else {
      logger.error('Executor health check FAILED -- claude CLI or credentials may be unavailable');
    }
  }
}
