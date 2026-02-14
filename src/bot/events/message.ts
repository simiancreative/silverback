import { App } from '@slack/bolt';
import { RequestQueue } from '../../queue/request-queue';
import { SessionManager } from '../../orchestrator/session';
import { Logger } from '../../logging/logger';
import { downloadTextFiles, SlackFileInfo } from '../utils/file-downloader';
import { buildPrompt } from '../utils/prompt-builder';

const logger = new Logger('message-handler');

export function registerMessageHandler(app: App, queue: RequestQueue, sessionManager: SessionManager, botToken: string): void {
  app.event('message', async ({ event, client }) => {
    // Only handle thread replies
    if (!('thread_ts' in event) || !event.thread_ts) return;
    // Ignore bot messages
    if ('bot_id' in event && event.bot_id) return;
    // Ignore subtypes (edits, deletes, etc.) but allow file_share
    if ('subtype' in event && event.subtype && event.subtype !== 'file_share') return;

    const threadTs = event.thread_ts;
    const text = 'text' in event ? (event.text || '').trim() : '';
    const userId = 'user' in event ? event.user || '' : '';
    const channelId = event.channel;

    // Extract files if present
    const files: SlackFileInfo[] = 'files' in event && Array.isArray((event as any).files)
      ? (event as any).files
      : [];

    // Ignore messages with no text and no files
    if (!text && files.length === 0) return;

    // Check if this thread has an active session
    const session = await sessionManager.getSession(threadTs);
    if (!session) return;

    // Download text files if present
    let prompt = text;
    if (files.length > 0 && botToken) {
      const downloaded = await downloadTextFiles(files, botToken);
      prompt = buildPrompt(text, downloaded);
    }

    logger.info('Thread reply in active session', { threadTs, userId, fileCount: files.length });

    const entry = await queue.enqueue({
      threadId: threadTs,
      channelId,
      userId,
      prompt,
    });

    if (entry.position > 0) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Follow-up queued. Position: ${entry.position}. Estimated wait: ~${Math.ceil(entry.estimatedWait / 60000)} minutes.`,
      });
    }
  });
}
