import { ContextCheckpoint, KeyValueStore, TaskContext } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('checkpointer');

export class ContextCheckpointer {
  constructor(private store: KeyValueStore) {}

  async checkpoint(ctx: TaskContext): Promise<void> {
    const checkpoint: ContextCheckpoint = {
      threadId: ctx.threadId,
      sessionId: ctx.sessionId,
      lastPrompt: ctx.prompt,
      summaryJson: { retryCount: ctx.retryCount },
      filesModified: ctx.filesModified || [],
      createdAt: new Date(),
    };

    await this.store.set(`checkpoint:${ctx.threadId}`, checkpoint);
    logger.info('Context checkpointed', { threadId: ctx.threadId });
  }

  async restore(threadId: string): Promise<ContextCheckpoint | null> {
    return this.store.get<ContextCheckpoint>(`checkpoint:${threadId}`);
  }

  async clear(threadId: string): Promise<void> {
    await this.store.delete(`checkpoint:${threadId}`);
  }
}
