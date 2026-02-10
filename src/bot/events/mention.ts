import { App } from '@slack/bolt';
import { RequestQueue } from '../../queue/request-queue';
import { Logger } from '../../logging/logger';

const logger = new Logger('mention-handler');

export function registerMentionHandler(app: App, queue: RequestQueue): void {
  app.event('app_mention', async ({ event, client, say }) => {
    const prompt = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!prompt) {
      await say({ text: 'Please provide a task description after mentioning me.', thread_ts: event.ts });
      return;
    }

    const threadTs = event.thread_ts || event.ts;

    logger.info('Received mention', { user: event.user, channel: event.channel, threadTs });

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
