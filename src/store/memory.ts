import { KeyValueStore } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('memory-store');

interface StoredValue {
  data: string;
  expiresAt?: number;
}

export class MemoryStore implements KeyValueStore {
  private store: Map<string, StoredValue> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    logger.info('Memory store initialized');
  }

  async get<T>(key: string): Promise<T | null> {
    const stored = this.store.get(key);
    if (!stored) return null;

    // Check if expired
    if (stored.expiresAt && Date.now() > stored.expiresAt) {
      this.store.delete(key);
      this.timers.delete(key);
      return null;
    }

    try {
      return JSON.parse(stored.data) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const stored: StoredValue = { data: serialized };

    // Clear existing timer if any
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(key);
    }

    if (ttlMs) {
      stored.expiresAt = Date.now() + ttlMs;

      // Set timer to delete key after TTL
      const timer = setTimeout(() => {
        this.store.delete(key);
        this.timers.delete(key);
      }, ttlMs);

      this.timers.set(key, timer);
    }

    this.store.set(key, stored);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.store.has(key);
    this.store.delete(key);

    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    return existed;
  }

  async exists(key: string): Promise<boolean> {
    const stored = this.store.get(key);
    if (!stored) return false;

    // Check if expired
    if (stored.expiresAt && Date.now() > stored.expiresAt) {
      this.store.delete(key);
      this.timers.delete(key);
      return false;
    }

    return true;
  }

  async disconnect(): Promise<void> {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.store.clear();
  }

  async del(key: string): Promise<number> {
    const existed = await this.delete(key);
    return existed ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    // Convert Redis glob pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);

    const matchedKeys: string[] = [];
    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        // Check if key is expired
        const isValid = await this.exists(key);
        if (isValid) {
          matchedKeys.push(key);
        }
      }
    }
    return matchedKeys;
  }
}
