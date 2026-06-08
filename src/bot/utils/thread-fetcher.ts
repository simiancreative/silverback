import { WebClient } from '@slack/web-api';
import { SlackFileInfo } from './file-downloader';
import { Logger } from '../../logging/logger';

const logger = new Logger('thread-fetcher');

const MAX_MESSAGES = 1000;

export interface ThreadMessage {
  userId: string;
  username: string;
  isBot: boolean;
  text: string;
  ts: string;
  files: SlackFileInfo[];
}

export async function fetchThreadMessages(
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  const allMessages: ThreadMessage[] = [];
  const userCache = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });

    const messages = response.messages ?? [];

    for (const msg of messages) {
      const rawMsg = msg as Record<string, unknown>;
      const isBot = !!(rawMsg.bot_id) || rawMsg.subtype === 'bot_message';
      const userId = (rawMsg.user as string) || '';
      const text = (rawMsg.text as string) || '';
      const ts = (rawMsg.ts as string) || '';
      const rawFiles = (rawMsg.files as SlackFileInfo[] | undefined) ?? [];

      let username: string;

      if (isBot) {
        username = (rawMsg.username as string) || 'bot';
      } else if (userId) {
        if (userCache.has(userId)) {
          username = userCache.get(userId)!;
        } else {
          try {
            const userInfo = await client.users.info({ user: userId });
            const profile = (userInfo.user as any)?.profile;
            const resolved =
              profile?.display_name ||
              profile?.real_name ||
              (userInfo.user as any)?.name ||
              userId;
            username = resolved;
            userCache.set(userId, resolved);
          } catch (err) {
            logger.warn('Failed to resolve username, falling back to userId', {
              userId,
              error: err instanceof Error ? err.message : String(err),
            });
            username = userId;
            userCache.set(userId, userId);
          }
        }
      } else {
        username = 'unknown';
      }

      allMessages.push({ userId, username, isBot, text, ts, files: rawFiles });

      if (allMessages.length >= MAX_MESSAGES) {
        logger.warn('Thread message cap reached, truncating', {
          channelId,
          threadTs,
          cap: MAX_MESSAGES,
        });
        return allMessages;
      }
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return allMessages;
}
