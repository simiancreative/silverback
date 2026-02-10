import { WebClient } from '@slack/web-api';
import { RequestQueue } from '../../queue/request-queue';
import { Logger } from '../../logging/logger';

const logger = new Logger('claude-command');

export function createClaudeHandler(queue: RequestQueue) {
  return async (command: any, client: WebClient): Promise<void> => {
    const prompt = command.text?.trim();

    if (!prompt) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'Usage: /claude <task description>',
      });
      return;
    }

    // Post visible message about the task
    const result = await client.chat.postMessage({
      channel: command.channel_id,
      text: `*Task from <@${command.user_id}>:*\n>${prompt}`,
    });

    const threadTs = result.ts!;

    logger.info('Claude command received', { user: command.user_id, channel: command.channel_id });

    const entry = await queue.enqueue({
      threadId: threadTs,
      channelId: command.channel_id,
      userId: command.user_id,
      prompt,
    });

    if (entry.position > 0) {
      await client.chat.postMessage({
        channel: command.channel_id,
        thread_ts: threadTs,
        text: `Queued. Position: ${entry.position}. Estimated wait: ~${Math.ceil(entry.estimatedWait / 60000)} minutes.`,
      });
    }
  };
}
