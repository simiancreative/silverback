import { WebClient } from '@slack/web-api';
import { Logger } from '../logging/logger';
import { classifyContent } from './content-classifier';
import { FileUploader } from './file-uploader';

const logger = new Logger('stream-handler');

export class StreamHandler {
  private currentText = '';
  private currentMessageTs: string | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private messageCount = 0;

  private constructor(
    private slack: WebClient,
    private channel: string,
    private threadTs: string,
    private fileUploader: FileUploader | null = null,
  ) {
    this.updateInterval = setInterval(() => this.flush(), 100);
  }

  static async create(
    slack: WebClient,
    channel: string,
    threadTs: string,
    fileUploader?: FileUploader
  ): Promise<StreamHandler> {
    const result = await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '_Claude is thinking..._',
    });
    const handler = new StreamHandler(slack, channel, threadTs, fileUploader || null);
    handler.currentMessageTs = result.ts!;
    return handler;
  }

  /**
   * Called when a new assistant message starts. Finalizes the current message
   * and prepares to post a new one.
   */
  async onMessageStart(): Promise<void> {
    // Finalize previous message if it has content
    if (this.currentMessageTs && this.currentText.trim()) {
      this.dirty = true;
      await this.flush();
      // Classify previous message and upload if structured
      await this.classifyAndUpload(this.currentText, this.currentMessageTs);
    }
    // Reset for the new message
    this.currentText = '';
    this.currentMessageTs = null;
  }

  onData(text: string): void {
    this.currentText += text;
    this.dirty = true;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const displayText = this.currentText.trim();
    if (!displayText) return;

    try {
      if (!this.currentMessageTs) {
        // Post a new message in the thread
        const result = await this.slack.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: displayText,
        });
        this.currentMessageTs = result.ts!;
        this.messageCount++;
      } else {
        // Update the current message with streaming content
        await this.slack.chat.update({
          channel: this.channel,
          ts: this.currentMessageTs,
          text: displayText,
        });
      }
    } catch (error: any) {
      if (error?.data?.error === 'ratelimited') {
        logger.warn('Slack rate limited, will retry on next flush');
        this.dirty = true;
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

    // Classify final message and upload if structured
    await this.classifyAndUpload(this.currentText, this.currentMessageTs);

    logger.info('Stream complete', { messages: this.messageCount });
  }

  /**
   * Abort the stream, appending an optional suffix to the current message.
   * Used when a new message in the same thread supersedes the current one.
   */
  async abort(suffix: string = '\n\n_(interrupted)_'): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Append suffix to current text
    this.currentText += suffix;
    this.dirty = true;
    await this.flush();

    logger.info('Stream aborted', { messages: this.messageCount });
  }

  private async classifyAndUpload(text: string, messageTs: string | null): Promise<void> {
    if (!this.fileUploader || !messageTs) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const result = classifyContent(trimmed);
    if (!result.isStructured) return;

    logger.info('Structured content detected', { reason: result.reason, description: result.description });

    // Upload file first, then rewrite message only on success
    const uploaded = await this.fileUploader.uploadAndRewrite({
      channel: this.channel,
      threadTs: this.threadTs,
      content: trimmed,
      description: result.description,
      existingMessageTs: messageTs,
    });

    if (!uploaded) {
      logger.warn('File upload failed, keeping original message');
    }
  }
}
