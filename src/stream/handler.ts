import { WebClient } from '@slack/web-api';
import { Logger } from '../logging/logger';

const logger = new Logger('stream-handler');

export class StreamHandler {
  private buffer = '';
  private fullText = '';
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private slackMessageTs: string;
  private dirty = false;
  private updateCount = 0;
  private readonly MAX_MESSAGE_LENGTH = 39000; // Slack limit ~40k, leave margin

  private constructor(
    private slack: WebClient,
    private channel: string,
    private threadTs: string,
    messageTs: string
  ) {
    this.slackMessageTs = messageTs;
    this.updateInterval = setInterval(() => this.flush(), 100);
  }

  static async create(
    slack: WebClient,
    channel: string,
    threadTs: string
  ): Promise<StreamHandler> {
    const result = await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '_Claude is thinking..._',
    });

    return new StreamHandler(slack, channel, threadTs, result.ts!);
  }

  onData(text: string): void {
    this.buffer += text;
    this.fullText += text;
    this.dirty = true;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    try {
      let displayText = this.fullText;

      // Truncate if too long for Slack
      if (displayText.length > this.MAX_MESSAGE_LENGTH) {
        displayText = '...(truncated)\n\n' + displayText.slice(-this.MAX_MESSAGE_LENGTH);
      }

      await this.slack.chat.update({
        channel: this.channel,
        ts: this.slackMessageTs,
        text: displayText || '_Processing..._',
      });

      this.updateCount++;
    } catch (error: any) {
      if (error?.data?.error === 'ratelimited') {
        logger.warn('Slack rate limited, will retry on next flush');
        this.dirty = true; // Retry on next interval
      } else {
        logger.error('Failed to update Slack message', { error: error?.message });
      }
    }
  }

  async complete(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Final flush
    this.dirty = true;
    await this.flush();

    logger.info('Stream complete', {
      totalLength: this.fullText.length,
      updates: this.updateCount
    });
  }

  getFullText(): string {
    return this.fullText;
  }
}
