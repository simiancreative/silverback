import { App } from '@slack/bolt';
import { ThreadPRManager } from '../../manager/thread-pr';
import { ThreadCompletionManager } from '../../manager/thread-completion';
import { SessionManager } from '../../orchestrator/session';
import { PRManager } from '../../git/pr';
import { Logger } from '../../logging/logger';

const logger = new Logger('reaction-handler');

export function registerReactionHandler(
  app: App,
  sessionManager: SessionManager,
  threadPRManager: ThreadPRManager,
  threadCompletionManager: ThreadCompletionManager,
): void {
  app.event('reaction_added', async ({ event, client }) => {
    // Only handle :approved: reaction
    if (event.reaction !== 'approved') return;

    // The item must be a message
    if (event.item.type !== 'message') return;

    const channelId = event.item.channel;
    const threadTs = event.item.ts;

    // Look up the session for this thread
    const session = await sessionManager.getSession(threadTs);
    if (!session) {
      logger.debug('No session found for reacted message', { threadTs });
      return;
    }

    // Look up PR mapping
    const mapping = await threadPRManager.getByThread(threadTs);
    if (!mapping?.prNumber || !mapping?.prUrl) {
      logger.info('No PR found for thread, ignoring approved reaction', { threadTs });
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'No PR found for this thread. Use `/sb-deploy` to create a PR first.',
      });
      return;
    }

    // Need workspace to run gh commands
    if (!session.workspacePath) {
      logger.warn('No workspace path for session', { threadTs });
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Cannot merge: workspace not found for this thread.',
      });
      return;
    }

    try {
      // Check PR status first
      const status = await PRManager.getStatus(session.workspacePath, mapping.prNumber);
      if (status === 'MERGED') {
        logger.info('PR already merged', { prNumber: mapping.prNumber, threadTs });
        // Add merged reaction anyway in case it's missing
        try {
          await client.reactions.add({ channel: channelId, timestamp: threadTs, name: 'merged' });
        } catch { /* already_reacted */ }
        return;
      }
      if (status === 'CLOSED') {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Cannot merge: PR #${mapping.prNumber} is closed.`,
        });
        return;
      }

      // Merge the PR
      await PRManager.merge(session.workspacePath, mapping.prNumber);
      logger.info('PR merged via approved reaction', { prNumber: mapping.prNumber, threadTs });

      // Add :merged: reaction
      await client.reactions.add({
        channel: channelId,
        timestamp: threadTs,
        name: 'merged',
      });

      // Post confirmation
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `PR #${mapping.prNumber} merged. :merged:`,
      });

      // Clean up thread resources
      await threadCompletionManager.cleanup(threadTs);
      logger.info('Thread completed via approved reaction', { threadTs });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to merge PR via reaction', { threadTs, prNumber: mapping.prNumber, error: errMsg });
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Failed to merge PR #${mapping.prNumber}: ${errMsg}`,
      });
    }
  });
}
