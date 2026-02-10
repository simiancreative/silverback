import { App } from '@slack/bolt';
import { WorkspaceManager } from '../../workspace/manager';
import { Logger } from '../../logging/logger';

const logger = new Logger('channel-join');

export function registerChannelJoinHandler(
  app: App,
  workspaceManager: WorkspaceManager,
  botUserId: string,
): void {
  app.event('member_joined_channel', async ({ event, client }) => {
    // Only handle when the bot itself joins
    if (event.user !== botUserId) return;

    const channelId = event.channel;
    logger.info('Bot joined channel', { channelId });

    try {
      // Read channel info to get topic
      const info = await client.conversations.info({ channel: channelId });
      const topic = info.channel?.topic?.value || '';

      const parsed = WorkspaceManager.parseRepoFromTopic(topic);

      if (!parsed) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'Hi! I need a GitHub repo to work with.\n\nEither:\n1. Set the channel topic to a GitHub repo URL (e.g., `github.com/org/repo`) and re-invite me\n2. Use `/connect github.com/org/repo` to connect manually',
        });
        return;
      }

      // Store channel-repo mapping
      await workspaceManager.setChannelRepo(channelId, parsed.org, parsed.repo);

      // Pre-warm the bare cache
      await workspaceManager.prewarmCache(parsed.org, parsed.repo);

      await client.chat.postMessage({
        channel: channelId,
        text: `Connected to *${parsed.org}/${parsed.repo}*. Ready to work!\n\nMention me with a task to get started.`,
      });

      logger.info('Channel connected to repo', { channelId, org: parsed.org, repo: parsed.repo });
    } catch (error) {
      logger.error('Failed to set up channel', { channelId, error });
      await client.chat.postMessage({
        channel: channelId,
        text: `Failed to set up repo connection. Error: ${(error as Error).message}\n\nTry using \`/connect github.com/org/repo\` manually.`,
      });
    }
  });

  // Handle bot removal from channel
  app.event('member_left_channel' as any, async ({ event, client }: any) => {
    if (event.user !== botUserId) return;
    logger.info('Bot removed from channel', { channelId: event.channel });
    await workspaceManager.removeChannelRepo(event.channel);
  });
}
