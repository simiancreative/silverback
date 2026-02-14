import { WebClient } from '@slack/web-api';
import { SessionManager } from '../orchestrator/session';
import { WorkspaceManager } from '../workspace/manager';
import { Logger } from '../logging/logger';
import { KeyValueStore } from '../types';

const logger = new Logger('thread-completion');

export class ThreadCompletionManager {
  constructor(
    private sessionManager: SessionManager,
    private workspaceManager: WorkspaceManager,
    private store: KeyValueStore,
  ) {}

  /**
   * Mark a thread as complete after successful deployment.
   * Adds a ✅ reaction to the original thread message and cleans up resources.
   */
  async markComplete(
    client: WebClient,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    // Add ✅ reaction to the original message that started the thread
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: threadTs,
        name: 'white_check_mark',
      });
      logger.info('Added completion reaction', { channelId, threadTs });
    } catch (error) {
      // Don't fail the deploy if reaction fails (e.g. already_reacted)
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('already_reacted')) {
        logger.info('Completion reaction already exists', { channelId, threadTs });
      } else {
        logger.warn('Failed to add completion reaction', { channelId, threadTs, error: errMsg });
      }
    }

    // Clean up thread resources
    await this.cleanup(threadTs);
  }

  /**
   * Clean up all resources associated with a thread.
   * Removes session, checkpoint, and workspace data.
   */
  async cleanup(threadTs: string): Promise<void> {
    try {
      // Clear session
      await this.sessionManager.clearSession(threadTs);
      logger.info('Session cleared', { threadTs });
    } catch (error) {
      logger.warn('Failed to clear session', { threadTs, error });
    }

    try {
      // Clear checkpoint
      await this.store.delete(`checkpoint:${threadTs}`);
      logger.info('Checkpoint cleared', { threadTs });
    } catch (error) {
      logger.warn('Failed to clear checkpoint', { threadTs, error });
    }

    try {
      // Clean up workspace (files + store entry)
      await this.workspaceManager.cleanupWorkspace(threadTs);
      logger.info('Workspace cleaned up', { threadTs });
    } catch (error) {
      logger.warn('Failed to clean up workspace', { threadTs, error });
    }
  }
}
