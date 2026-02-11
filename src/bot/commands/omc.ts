import { WebClient } from '@slack/web-api';
import { RequestQueue } from '../../queue/request-queue';
import { Logger } from '../../logging/logger';

const logger = new Logger('omc-command');

export function createOmcHandler(queue: RequestQueue, commandName: string, keyword: string) {
  return async (command: any, client: WebClient): Promise<void> => {
    const task = command.text?.trim();

    if (!task) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Usage: /${commandName} <task description>`,
      });
      return;
    }

    // Post visible message about the task
    const result = await client.chat.postMessage({
      channel: command.channel_id,
      text: `*${keyword} from <@${command.user_id}>:*\n>${task}`,
    });

    const threadTs = result.ts!;

    logger.info('OMC command received', { keyword, user: command.user_id, channel: command.channel_id });

    const prompt = `${keyword}: ${task}`;

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

export function createOmcCancelHandler(queue: RequestQueue) {
  return async (command: any, client: WebClient): Promise<void> => {
    // Post visible message about the cancel request
    const result = await client.chat.postMessage({
      channel: command.channel_id,
      text: `*cancel from <@${command.user_id}>*`,
    });

    const threadTs = result.ts!;

    logger.info('OMC cancel command received', { user: command.user_id, channel: command.channel_id });

    await queue.enqueue({
      threadId: threadTs,
      channelId: command.channel_id,
      userId: command.user_id,
      prompt: 'cancel',
    });
  };
}
