import { App } from '@slack/bolt';
import { RequestQueue } from '../../queue/request-queue';
import { SessionManager } from '../../orchestrator/session';
import { Logger } from '../../logging/logger';

const logger = new Logger('message-handler');

export function registerMessageHandler(app: App, queue: RequestQueue, sessionManager: SessionManager): void {
  app.event('message', async ({ event, client }) => {
    // Only handle thread replies
    if (!('thread_ts' in event) || !event.thread_ts) return;
    // Ignore bot messages
    if ('bot_id' in event && event.bot_id) return;
    // Ignore subtypes (edits, deletes, etc.)
    if ('subtype' in event && event.subtype) return;

    const threadTs = event.thread_ts;
    const text = 'text' in event ? event.text || '' : '';
    const userId = 'user' in event ? event.user || '' : '';
    const channelId = event.channel;

    // Check if this thread has an active session
    const session = await sessionManager.getSession(threadTs);
    if (!session) return;

    logger.info('Thread reply in active session', { threadTs, userId });

    const entry = await queue.enqueue({
      threadId: threadTs,
      channelId,
      userId,
      prompt: text,
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
