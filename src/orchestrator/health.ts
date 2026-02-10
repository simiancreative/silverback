import { ContainerPool } from './pool';
import { Logger } from '../logging/logger';

const logger = new Logger('health-checker');

export class ContainerHealthChecker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;

  constructor(
    private pool: ContainerPool,
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
    const status = this.pool.getPoolStatus();
    logger.info('Pool health check', status);

    if (status.unhealthy > 0) {
      logger.warn('Unhealthy containers detected', { count: status.unhealthy });
    }

    if (status.idle === 0 && status.busy === status.total) {
      logger.warn('All containers busy - pool may need scaling');
    }
  }
}
