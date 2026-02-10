import Redis from 'ioredis';
import { KeyValueStore } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('redis-store');

export class RedisStore implements KeyValueStore {
  private client: Redis;

  constructor(url: string) {
    this.client = new Redis(url);

    this.client.on('connect', () => logger.info('Redis connected'));
    this.client.on('error', (err) => logger.error('Redis error', { error: err.message }));
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs) {
      await this.client.set(key, serialized, 'PX', ttlMs);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    const count = await this.client.del(key);
    return count > 0;
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.client.exists(key);
    return count > 0;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  async del(key: string): Promise<number> {
    return await this.client.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    return await this.client.keys(pattern);
  }
}
