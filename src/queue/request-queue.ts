import { v4 as uuidv4 } from 'uuid';
import { QueuedRequest, QueueEntry, QueueStatus, KeyValueStore } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('request-queue');

const QUEUE_PENDING_KEY = 'queue:pending';
const QUEUE_ACTIVE_KEY = 'queue:active';
const QUEUE_ACTIVE_STARTED_KEY = 'queue:active:started';

const DEFAULT_STUCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class RequestQueue {
  // In-memory cache mirrors the store for synchronous reads (getQueueStatus)
  private queue: QueuedRequest[] = [];
  private activeSession: QueuedRequest | null = null;
  private readonly maxConcurrent: number;
  private readonly store: KeyValueStore;
  private readonly stuckTimeoutMs: number;
  private processingCallback: ((request: QueuedRequest) => Promise<void>) | null = null;
  private processingInterval: ReturnType<typeof setInterval> | null = null;
  private abortCallback: (() => Promise<void>) | null = null;

  constructor(config: { maxConcurrent: number; stuckTimeoutMs?: number }, store: KeyValueStore, abortCallback?: () => Promise<void>) {
    this.maxConcurrent = config.maxConcurrent;
    this.store = store;
    this.stuckTimeoutMs = config.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
    this.abortCallback = abortCallback ?? null;
  }

  // --- Store persistence helpers ---

  private async persistPendingQueue(): Promise<void> {
    await this.store.set(QUEUE_PENDING_KEY, this.queue);
  }

  private async persistActive(): Promise<void> {
    if (this.activeSession) {
      await this.store.set(QUEUE_ACTIVE_KEY, this.activeSession);
      await this.store.set(QUEUE_ACTIVE_STARTED_KEY, new Date().toISOString());
    } else {
      await this.store.delete(QUEUE_ACTIVE_KEY);
      await this.store.delete(QUEUE_ACTIVE_STARTED_KEY);
    }
  }

  private async loadFromStore(): Promise<void> {
    const pending = await this.store.get<QueuedRequest[]>(QUEUE_PENDING_KEY);
    this.queue = pending || [];
    const active = await this.store.get<QueuedRequest>(QUEUE_ACTIVE_KEY);
    this.activeSession = active || null;
  }

  // --- Public API ---

  async enqueue(request: Omit<QueuedRequest, 'id' | 'enqueuedAt' | 'position'>): Promise<QueueEntry> {
    const entry: QueuedRequest = {
      ...request,
      id: uuidv4(),
      enqueuedAt: new Date(),
      position: this.queue.length + 1,
    };

    // Supersede: replace any pending entry for the same thread
    const existingIdx = this.queue.findIndex(r => r.threadId === request.threadId);
    if (existingIdx !== -1) {
      logger.info('Superseding pending request for thread', {
        oldId: this.queue[existingIdx].id,
        newId: entry.id,
        threadId: request.threadId,
      });
      entry.position = this.queue[existingIdx].position;
      this.queue[existingIdx] = entry;
    } else {
      this.queue.push(entry);
    }

    // Interrupt: if active session is for the same thread, abort and front-load
    let interrupted = false;
    if (this.activeSession && this.activeSession.threadId === request.threadId && this.abortCallback) {
      logger.info('Interrupting active session for thread', {
        activeId: this.activeSession.id,
        newId: entry.id,
        threadId: request.threadId,
      });

      // If we didn't supersede a pending entry, we need to front-load the new entry
      if (existingIdx === -1) {
        // Move the new entry to position 1 (front of queue)
        const idx = this.queue.indexOf(entry);
        if (idx > 0) {
          this.queue.splice(idx, 1);
          this.queue.unshift(entry);
          this.updatePositions();
        }
      }

      interrupted = true;
      await this.persistPendingQueue();

      // Trigger abort AFTER the replacement is in the queue
      // The abort will cause the onProcess callback to throw AbortError,
      // which hits finally -> release(), then the polling loop picks up the replacement
      this.abortCallback().catch(err => {
        logger.error('Failed to abort active session', { error: err });
      });
    } else {
      await this.persistPendingQueue();
    }

    logger.info('Request enqueued', { id: entry.id, position: entry.position, threadId: entry.threadId, interrupted });

    return {
      id: entry.id,
      position: interrupted ? 0 : (this.activeSession ? entry.position : 0),
      estimatedWait: interrupted ? 0 : (this.activeSession ? this.estimateWait(entry.position) : 0),
      interrupted,
    };
  }

  private estimateWait(position: number): number {
    return position * 2 * 60 * 1000; // Average 2 min per task
  }

  async dequeue(): Promise<QueuedRequest | null> {
    if (this.activeSession || this.queue.length === 0) {
      return null;
    }
    this.activeSession = this.queue.shift()!;
    this.updatePositions();
    await this.persistPendingQueue();
    await this.persistActive();

    logger.info('Request dequeued', { id: this.activeSession.id, threadId: this.activeSession.threadId });
    return this.activeSession;
  }

  async release(): Promise<void> {
    if (this.activeSession) {
      logger.info('Session released', { id: this.activeSession.id });
      this.activeSession = null;
      await this.persistActive();
    }
  }

  private updatePositions(): void {
    this.queue.forEach((r, i) => {
      r.position = i + 1;
    });
  }

  getQueueStatus(): QueueStatus {
    return {
      active: this.activeSession !== null,
      queueLength: this.queue.length,
      positions: this.queue.map(r => ({
        id: r.id,
        position: r.position,
        waitTime: this.estimateWait(r.position),
      })),
    };
  }

  getActiveThreadId(): string | null {
    return this.activeSession?.threadId ?? null;
  }

  onProcess(callback: (request: QueuedRequest) => Promise<void>): void {
    this.processingCallback = callback;
  }

  startProcessing(): void {
    if (this.processingInterval) return;

    this.processingInterval = setInterval(async () => {
      if (!this.processingCallback) return;

      // Check for stuck active request
      await this.checkAndReleaseStuck();

      const request = await this.dequeue();
      if (!request) return;

      try {
        await this.processingCallback(request);
      } catch (error) {
        logger.error('Processing failed', { error, requestId: request.id });
      } finally {
        await this.release();
      }
    }, 1000); // Check every second
  }

  stopProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  /**
   * Check if the active request is stuck (older than stuckTimeoutMs) and release it.
   */
  private async checkAndReleaseStuck(): Promise<void> {
    if (!this.activeSession) return;

    const startedAt = await this.store.get<string>(QUEUE_ACTIVE_STARTED_KEY);
    if (!startedAt) return;

    const elapsed = Date.now() - new Date(startedAt).getTime();
    if (elapsed > this.stuckTimeoutMs) {
      logger.warn('Releasing stuck active request', {
        id: this.activeSession.id,
        threadId: this.activeSession.threadId,
        elapsedMs: elapsed,
        stuckTimeoutMs: this.stuckTimeoutMs,
      });
      this.activeSession = null;
      await this.persistActive();
    }
  }

  /**
   * Recover queue state on startup. Loads persisted state from the store
   * and releases any stuck active request that may have been left behind
   * if the process restarted mid-processing.
   */
  async recoverQueue(): Promise<void> {
    await this.loadFromStore();

    if (this.activeSession) {
      logger.warn('Found active request on startup, releasing (likely from previous process)', {
        id: this.activeSession.id,
        threadId: this.activeSession.threadId,
      });
      this.activeSession = null;
      await this.persistActive();
    }
  }
}
