import { FailureType, RecoveryResult, TaskContext } from '../types';
import { KeyValueStore } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('failure-handler');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class FailureHandler {
  private readonly MAX_RETRIES = 3;
  private readonly BACKOFF_BASE_MS = 1000;

  constructor(
    private store: KeyValueStore
  ) {}

  async handle(error: Error, context: TaskContext): Promise<RecoveryResult> {
    const type = this.classifyError(error);
    logger.info('Handling failure', { type, message: error.message, retryCount: context.retryCount });

    switch (type) {
      case FailureType.TRANSIENT:
        return this.handleTransient(error, context);
      case FailureType.CLAUDE_ERROR:
        return this.handleClaudeError(error, context);
      case FailureType.IMAGE_ERROR:
        return this.handleImageError(context);
      case FailureType.SESSION_CORRUPT:
        return this.handleSessionCorrupt(context);
      case FailureType.AUTH_EXPIRED:
        return this.handleAuthExpired(context);
      case FailureType.UNKNOWN:
      default:
        return this.handleUnknown(error, context);
    }
  }

  private async handleTransient(error: Error, ctx: TaskContext): Promise<RecoveryResult> {
    if (ctx.retryCount < this.MAX_RETRIES) {
      const delay = this.BACKOFF_BASE_MS * Math.pow(2, ctx.retryCount);
      await sleep(delay);

      ctx.retryCount++;

      return { success: true, action: 'retried', message: `Retrying (attempt ${ctx.retryCount})` };
    }

    return { success: false, action: 'aborted', message: 'Max retries exceeded for transient error' };
  }

  private async handleClaudeError(error: Error, ctx: TaskContext): Promise<RecoveryResult> {
    if (ctx.retryCount < this.MAX_RETRIES) {
      const delay = this.BACKOFF_BASE_MS * Math.pow(2, ctx.retryCount + 1);
      await sleep(delay);

      ctx.retryCount++;
      return { success: true, action: 'retried', message: `Claude error, backing off (attempt ${ctx.retryCount})` };
    }

    return { success: false, action: 'escalated', message: 'Claude error persisted after retries' };
  }

  private async handleImageError(ctx: TaskContext): Promise<RecoveryResult> {
    logger.info('Image processing error detected, will retry without images', { threadId: ctx.threadId });
    return { success: true, action: 'retried_without_images', message: 'Image processing failed, retrying without images' };
  }

  private async handleSessionCorrupt(ctx: TaskContext): Promise<RecoveryResult> {
    await this.store.delete(`session:${ctx.threadId}`);
    return { success: false, action: 'escalated', message: 'Session corrupt, cleared mapping' };
  }

  private async handleAuthExpired(ctx: TaskContext): Promise<RecoveryResult> {
    return { success: false, action: 'aborted', message: 'Auth expired, admin notified' };
  }

  private async handleUnknown(error: Error, ctx: TaskContext): Promise<RecoveryResult> {
    logger.error('Unknown error type', { error: error.message, stack: error.stack });
    return { success: false, action: 'aborted', message: `Unknown error: ${error.message}` };
  }

  private classifyError(error: Error): FailureType {
    const msg = error.message.toLowerCase();

    // Image errors — must be checked BEFORE generic 'claude' match
    if (msg.includes('could not process image') ||
        msg.includes('image_content_error') ||
        (msg.includes('invalid_request_error') && msg.includes('image'))) {
      return FailureType.IMAGE_ERROR;
    }

    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound')) {
      return FailureType.TRANSIENT;
    }
    if (msg.includes('unauthorized') || msg.includes('401') || msg.includes('token expired')) {
      return FailureType.AUTH_EXPIRED;
    }
    if (msg.includes('session') || msg.includes('corrupt') || msg.includes('invalid state')) {
      return FailureType.SESSION_CORRUPT;
    }
    if (msg.includes('claude') || msg.includes('anthropic') || msg.includes('rate limit')) {
      return FailureType.CLAUDE_ERROR;
    }

    return FailureType.UNKNOWN;
  }
}
