import { WorkspaceManager } from '../../workspace/manager';
import { Logger } from '../../logging/logger';

const logger = new Logger('connect-command');

export function createConnectHandler(workspaceManager: WorkspaceManager) {
  return async ({ command, ack, respond }: any) => {
    await ack();

    const repoUrl = command.text?.trim();
    if (!repoUrl) {
      await respond('Usage: `/connect github.com/org/repo`');
      return;
    }

    const parsed = WorkspaceManager.parseRepoFromTopic(repoUrl);
    if (!parsed) {
      await respond('Invalid repo URL. Use format: `github.com/org/repo`');
      return;
    }

    try {
      await workspaceManager.setChannelRepo(command.channel_id, parsed.org, parsed.repo);
      await workspaceManager.prewarmCache(parsed.org, parsed.repo);
      await respond(`Connected this channel to *${parsed.org}/${parsed.repo}*. Ready to work!`);
      logger.info('Channel connected via /connect', { channelId: command.channel_id, org: parsed.org, repo: parsed.repo });
    } catch (error) {
      logger.error('Failed to connect repo', { error });
      await respond(`Failed to connect: ${(error as Error).message}`);
    }
  };
}
