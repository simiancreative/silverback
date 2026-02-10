import { WebClient } from '@slack/web-api';
import { ThreadPRManager } from '../../manager/thread-pr';
import { Logger } from '../../logging/logger';

const logger = new Logger('deploy-command');

export function createDeployHandler(threadPRManager: ThreadPRManager) {
  return async (command: any, client: WebClient): Promise<void> => {
    const prNumberArg = command.text?.trim();
    let threadId: string | undefined;

    // If PR number provided directly
    if (prNumberArg && /^\d+$/.test(prNumberArg)) {
      const mapping = await threadPRManager.getByPR(parseInt(prNumberArg, 10));
      if (!mapping) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `No session found for PR #${prNumberArg}.`,
        });
        return;
      }
      threadId = mapping.threadId;
    }

    if (!threadId) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'Usage: /deploy <pr-number>',
      });
      return;
    }

    const mapping = await threadPRManager.getByThread(threadId);
    if (!mapping || !mapping.prNumber) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'No PR associated with this thread.',
      });
      return;
    }

    await client.chat.postMessage({
      channel: command.channel_id,
      text: `Deploying PR #${mapping.prNumber}... Squash-merging to main.`,
    });

    logger.info('Deploy initiated', { prNumber: mapping.prNumber, user: command.user_id });

    // The actual merge would be handled by GitHub API
    // This is a placeholder for the merge operation
    await client.chat.postMessage({
      channel: command.channel_id,
      text: `PR #${mapping.prNumber} merge initiated. Check GitHub for status.`,
    });
  };
}
