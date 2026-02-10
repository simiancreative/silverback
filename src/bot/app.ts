import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { Logger } from '../logging/logger';

const logger = new Logger('bot');

export function createApp(): App {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  return app;
}

export function getWebClient(): WebClient {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}
