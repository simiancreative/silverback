import { WebClient } from '@slack/web-api';
import { RequestQueue } from '../../queue/request-queue';

export function createQueueHandler(queue: RequestQueue) {
  return async (command: any, client: WebClient): Promise<void> => {
    const status = queue.getQueueStatus();

    let text: string;
    if (status.queueLength === 0 && !status.active) {
      text = 'No tasks in queue. Claude is ready!';
    } else {
      const lines = [`*Queue Status:* ${status.active ? 'Processing' : 'Idle'}`];
      lines.push(`*Pending:* ${status.queueLength} tasks`);

      for (const pos of status.positions) {
        lines.push(`  #${pos.position}: ~${Math.ceil(pos.waitTime / 60000)} min wait`);
      }

      text = lines.join('\n');
    }

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text,
    });
  };
}
