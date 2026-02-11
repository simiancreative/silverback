import { WebClient } from '@slack/web-api';
import { WorkspaceManager } from '../../workspace/manager';
import { Logger } from '../../logging/logger';

const logger = new Logger('connect-command');

export function createConnectHandler(workspaceManager: WorkspaceManager) {
  return async (command: any, client: WebClient): Promise<void> => {
    const repoUrl = command.text?.trim();
    if (!repoUrl) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'Usage: `/sb-connect github.com/org/repo`',
      });
      return;
    }

    const parsed = WorkspaceManager.parseRepoFromTopic(repoUrl);
    if (!parsed) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'Invalid repo URL. Use format: `github.com/org/repo`',
      });
      return;
    }

    // Post a visible progress message
    const progress = await client.chat.postMessage({
      channel: command.channel_id,
      text: `:hourglass_flowing_sand: Connecting to *${parsed.org}/${parsed.repo}*... cloning repository`,
    });

    try {
      await workspaceManager.setChannelRepo(command.channel_id, parsed.org, parsed.repo);
      await workspaceManager.prewarmCache(parsed.org, parsed.repo);
      await client.chat.update({
        channel: command.channel_id,
        ts: progress.ts!,
        text: `:white_check_mark: Connected to *${parsed.org}/${parsed.repo}*. Ready to work!`,
      });
      logger.info('Channel connected via /connect', { channelId: command.channel_id, org: parsed.org, repo: parsed.repo });
    } catch (error) {
      logger.error('Failed to connect repo', { error });
      await client.chat.update({
        channel: command.channel_id,
        ts: progress.ts!,
        text: `:x: Failed to connect to *${parsed.org}/${parsed.repo}*: ${(error as Error).message}`,
      });
    }
  };
}
