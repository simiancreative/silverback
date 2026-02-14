import { WebClient } from '@slack/web-api';
import { Logger } from '../logging/logger';

const logger = new Logger('file-uploader');

export class FileUploader {
  constructor(private slack: WebClient) {}

  /**
   * Upload markdown content as a .md file and rewrite the existing message to a description.
   * Returns true on success, false on failure. Never throws.
   */
  async uploadAndRewrite(opts: {
    channel: string;
    threadTs: string;
    content: string;
    description: string;
    existingMessageTs: string;
  }): Promise<boolean> {
    try {
      // Generate filename with compact ISO timestamp
      const now = new Date();
      const timestamp = now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '-')
        .slice(0, 15); // YYYYMMDD-HHmmss
      const filename = `response-${timestamp}.md`;

      // Upload file to Slack
      const uploadResult = await this.slack.filesUploadV2({
        channel_id: opts.channel,
        thread_ts: opts.threadTs,
        content: opts.content,
        filename: filename,
        title: 'Claude Response',
        initial_comment: opts.description,
      });

      if (!uploadResult.ok) {
        logger.error('File upload failed', { error: uploadResult.error });
        return false;
      }

      // Rewrite existing message if provided
      if (opts.existingMessageTs) {
        const updatedText = `${opts.description}\n\n_(full response attached as file above)_`;
        const updateResult = await this.slack.chat.update({
          channel: opts.channel,
          ts: opts.existingMessageTs,
          text: updatedText,
        });

        if (!updateResult.ok) {
          logger.error('Message update failed', { error: updateResult.error });
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Error in uploadAndRewrite', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
