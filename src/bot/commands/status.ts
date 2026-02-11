import { WebClient } from '@slack/web-api';
import { RequestQueue } from '../../queue/request-queue';
import { AuthVerifier } from '../../auth/verifier';
import { Executor } from '../../executor/interface';
import { WorkspaceManager } from '../../workspace/manager';

export function createStatusHandler(queue: RequestQueue, auth: AuthVerifier, executor?: Executor, workspaceManager?: WorkspaceManager) {
  return async (command: any, client: WebClient): Promise<void> => {
    const queueStatus = queue.getQueueStatus();
    const authStatus = await auth.verify();

    let executorStatus = 'Unknown';
    if (executor) {
      const healthy = await executor.healthCheck();
      executorStatus = healthy ? 'Healthy' : 'UNHEALTHY';
    }

    let connectionText = 'Not connected';
    if (workspaceManager) {
      const mapping = await workspaceManager.getChannelRepo(command.channel_id);
      if (mapping) {
        connectionText = `${mapping.org}/${mapping.repo}`;
      }
    }

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'SilverBack Status' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Repo:* ${connectionText}` },
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
      text: 'SilverBack Status',
      blocks,
    });
  };
}
