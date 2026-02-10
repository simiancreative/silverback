import { App } from '@slack/bolt';
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { CommandDefinition } from '../../types';
import { Logger } from '../../logging/logger';

const logger = new Logger('command-registry');

export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();
  private handlers: Map<string, (command: any, client: any) => Promise<void>> = new Map();

  constructor(private app: App) {}

  async loadFromConfig(configPath: string): Promise<void> {
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const config = yaml.load(content) as { commands: CommandDefinition[] };

      for (const cmd of config.commands) {
        if (!cmd.enabled) continue;
        this.commands.set(cmd.name, cmd);
        this.registerCommand(cmd);
        logger.info(`Registered command: /${cmd.name}`);
      }
    } catch (error) {
      logger.error('Failed to load command config', { error, configPath });
      throw error;
    }
  }

  private registerCommand(cmd: CommandDefinition): void {
    this.app.command(`/${cmd.name}`, async ({ command, ack, client }) => {
      await ack();

      const handler = this.getHandler(cmd);
      if (handler) {
        await handler(command, client);
      } else {
        await client.chat.postMessage({
          channel: command.channel_id,
          text: `Command /${cmd.name} is registered but has no handler implementation yet.`,
        });
      }
    });
  }

  private getHandler(cmd: CommandDefinition): ((command: any, client: any) => Promise<void>) | null {
    return this.handlers.get(cmd.name) || null;
  }

  registerHandler(name: string, handler: (command: any, client: any) => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  getCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }
}
