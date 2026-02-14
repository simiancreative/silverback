import { App } from '@slack/bolt';
import { RequestQueue } from '../../queue/request-queue';
import { Logger } from '../../logging/logger';
import { downloadTextFiles, SlackFileInfo } from '../utils/file-downloader';
import { buildPrompt } from '../utils/prompt-builder';

const logger = new Logger('mention-handler');

export function registerMentionHandler(app: App, queue: RequestQueue, botToken: string): void {
  app.event('app_mention', async ({ event, client, say }) => {
    const textPrompt = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    // Extract files if present
    const files: SlackFileInfo[] = 'files' in event && Array.isArray((event as any).files)
      ? (event as any).files
      : [];

    if (!textPrompt && files.length === 0) {
      await say({ text: 'Please provide a task description after mentioning me.', thread_ts: event.ts });
      return;
    }

    const threadTs = event.thread_ts || event.ts;

    // Download text files if present
    let prompt = textPrompt;
    if (files.length > 0 && botToken) {
      const downloaded = await downloadTextFiles(files, botToken);
      prompt = buildPrompt(textPrompt, downloaded);
    }

    logger.info('Received mention', { user: event.user, channel: event.channel, threadTs, fileCount: files.length });

    const entry = await queue.enqueue({
      threadId: threadTs as string,
      channelId: event.channel,
      userId: event.user || 'unknown',
      prompt,
    });

    if (entry.position > 0) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `Your request is queued. Position: ${entry.position}. Estimated wait: ~${Math.ceil(entry.estimatedWait / 60000)} minutes.`,
      });
    }
  });
}
