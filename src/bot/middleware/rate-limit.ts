import { Logger } from '../../logging/logger';

const logger = new Logger('rate-limit');

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 10, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  isRateLimited(userId: string): boolean {
    const now = Date.now();
    const entry = this.limits.get(userId);

    if (!entry || now > entry.resetAt) {
      this.limits.set(userId, { count: 1, resetAt: now + this.windowMs });
      return false;
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      logger.warn('Rate limited', { userId, count: entry.count });
      return true;
    }

    return false;
  }

  getRemainingRequests(userId: string): number {
    const entry = this.limits.get(userId);
    if (!entry || Date.now() > entry.resetAt) return this.maxRequests;
    return Math.max(0, this.maxRequests - entry.count);
  }
}
