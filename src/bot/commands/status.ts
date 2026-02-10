import { WebClient } from '@slack/web-api';
import { RequestQueue } from '../../queue/request-queue';
import { AuthVerifier } from '../../auth/verifier';
import { Executor } from '../../executor/interface';

export function createStatusHandler(queue: RequestQueue, auth: AuthVerifier, executor?: Executor) {
  return async (command: any, client: WebClient): Promise<void> => {
    const queueStatus = queue.getQueueStatus();
    const authStatus = await auth.verify();

    // Add executor info to blocks
    let executorStatus = 'Unknown';
    if (executor) {
      const healthy = await executor.healthCheck();
      executorStatus = healthy ? 'Healthy' : 'UNHEALTHY';
    }

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Claude Bot Status' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Auth:* ${authStatus.valid ? 'Valid' : 'EXPIRED'}` },
          { type: 'mrkdwn', text: `*Queue:* ${queueStatus.queueLength} pending` },
          { type: 'mrkdwn', text: `*Active:* ${queueStatus.active ? 'Yes' : 'No'}` },
          { type: 'mrkdwn', text: `*Executor:* ${process.env.EXECUTOR || 'process'} (${executorStatus})` },
        ],
      },
    ];

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'Claude Bot Status',
      blocks,
    });
  };
}
