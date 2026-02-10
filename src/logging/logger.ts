import pino from 'pino';

const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export class Logger {
  private logger: pino.Logger;

  constructor(module: string) {
    this.logger = baseLogger.child({ module });
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.logger.info(data || {}, msg);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.logger.warn(data || {}, msg);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.logger.error(data || {}, msg);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.logger.debug(data || {}, msg);
  }
}
