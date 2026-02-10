import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logging/logger';

const logger = new Logger('config-watcher');

export class ConfigWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private configPath: string,
    private onChange: () => Promise<void>,
    private debounceMs = 1000
  ) {}

  start(): void {
    const dir = path.dirname(this.configPath);
    const filename = path.basename(this.configPath);

    this.watcher = fs.watch(dir, (eventType, changedFile) => {
      if (changedFile === filename) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);

        this.debounceTimer = setTimeout(async () => {
          logger.info('Config file changed, reloading', { configPath: this.configPath });
          try {
            await this.onChange();
          } catch (error) {
            logger.error('Failed to reload config', { error });
          }
        }, this.debounceMs);
      }
    });

    logger.info('Watching config file', { configPath: this.configPath });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
