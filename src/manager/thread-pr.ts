import { KeyValueStore } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('thread-pr-manager');

interface ThreadMapping {
  threadId: string;
  channelId: string;
  claudeSessionId: string;
  containerId: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class ThreadPRManager {
  constructor(private store: KeyValueStore) {}

  async createMapping(data: Omit<ThreadMapping, 'createdAt' | 'updatedAt'>): Promise<void> {
    const mapping: ThreadMapping = {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.set(`thread:${data.threadId}`, mapping);

    if (data.prNumber) {
      await this.store.set(`pr:${data.prNumber}`, data.threadId);
    }

    logger.info('Thread mapping created', { threadId: data.threadId });
  }

  async getByThread(threadId: string): Promise<ThreadMapping | null> {
    return this.store.get<ThreadMapping>(`thread:${threadId}`);
  }

  async getByPR(prNumber: number): Promise<ThreadMapping | null> {
    const threadId = await this.store.get<string>(`pr:${prNumber}`);
    if (!threadId) return null;
    return this.getByThread(threadId);
  }

  async attachPR(threadId: string, prNumber: number, prUrl: string, branch: string): Promise<void> {
    const mapping = await this.getByThread(threadId);
    if (mapping) {
      mapping.prNumber = prNumber;
      mapping.prUrl = prUrl;
      mapping.branch = branch;
      mapping.updatedAt = new Date();
      await this.store.set(`thread:${threadId}`, mapping);
      await this.store.set(`pr:${prNumber}`, threadId);
      logger.info('PR attached to thread', { threadId, prNumber, prUrl });
    }
  }
}
