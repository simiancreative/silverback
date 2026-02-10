import { Middleware, SlackEventMiddlewareArgs } from '@slack/bolt';
import { Logger } from '../../logging/logger';

const logger = new Logger('auth-middleware');

// Allowed user IDs or groups (configured via env)
const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || '').split(',').filter(Boolean)
);

const ADMIN_USERS = new Set(
  (process.env.ADMIN_USERS || '').split(',').filter(Boolean)
);

export function isAllowed(userId: string): boolean {
  // If no allowed users configured, allow everyone
  if (ALLOWED_USERS.size === 0) return true;
  return ALLOWED_USERS.has(userId) || ADMIN_USERS.has(userId);
}

export function isAdmin(userId: string): boolean {
  return ADMIN_USERS.has(userId);
}

export function createAuthMiddleware() {
  return async ({ event, next, client }: any): Promise<void> => {
    const userId = event?.user;
    if (!userId) {
      await next();
      return;
    }

    if (!isAllowed(userId)) {
      logger.warn('Unauthorized access attempt', { userId });
      // Silently ignore unauthorized users
      return;
    }

    await next();
  };
}
