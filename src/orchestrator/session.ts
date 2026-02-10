import { SessionMapping, KeyValueStore } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('session-manager');

export class SessionManager {
  constructor(private store: KeyValueStore) {}

  async createSession(mapping: SessionMapping): Promise<void> {
    await this.store.set(`session:${mapping.threadId}`, mapping);
    logger.info('Session created', { threadId: mapping.threadId, containerId: mapping.containerId });
  }

  async getSession(threadId: string): Promise<SessionMapping | null> {
    return this.store.get<SessionMapping>(`session:${threadId}`);
  }

  async updateSession(threadId: string, updates: Partial<SessionMapping>): Promise<void> {
    const existing = await this.getSession(threadId);
    if (!existing) {
      logger.warn('Attempted to update non-existent session', { threadId });
      return;
    }

    const updated = { ...existing, ...updates, updatedAt: new Date() };
    await this.store.set(`session:${threadId}`, updated);
    logger.info('Session updated', { threadId, updates: Object.keys(updates) });
  }

  async clearSession(threadId: string): Promise<void> {
    await this.store.delete(`session:${threadId}`);
    logger.info('Session cleared', { threadId });
  }

  async hasActiveSession(threadId: string): Promise<boolean> {
    return this.store.exists(`session:${threadId}`);
  }
}
