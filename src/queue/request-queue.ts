import { v4 as uuidv4 } from 'uuid';
import { QueuedRequest, QueueEntry, QueueStatus } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('request-queue');

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private activeSession: QueuedRequest | null = null;
  private readonly maxConcurrent: number;
  private processingCallback: ((request: QueuedRequest) => Promise<void>) | null = null;
  private processingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: { maxConcurrent: number }) {
    this.maxConcurrent = config.maxConcurrent;
  }

  async enqueue(request: Omit<QueuedRequest, 'id' | 'enqueuedAt' | 'position'>): Promise<QueueEntry> {
    const entry: QueuedRequest = {
      ...request,
      id: uuidv4(),
      enqueuedAt: new Date(),
      position: this.queue.length + 1,
    };
    this.queue.push(entry);

    logger.info('Request enqueued', { id: entry.id, position: entry.position, threadId: entry.threadId });

    return {
      id: entry.id,
      position: this.activeSession ? entry.position : 0,
      estimatedWait: this.activeSession ? this.estimateWait(entry.position) : 0,
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
    logger.info('Request dequeued', { id: this.activeSession.id, threadId: this.activeSession.threadId });
    return this.activeSession;
  }

  release(): void {
    if (this.activeSession) {
      logger.info('Session released', { id: this.activeSession.id });
      this.activeSession = null;
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

  onProcess(callback: (request: QueuedRequest) => Promise<void>): void {
    this.processingCallback = callback;
  }

  startProcessing(): void {
    if (this.processingInterval) return;

    this.processingInterval = setInterval(async () => {
      if (!this.processingCallback) return;

      const request = await this.dequeue();
      if (!request) return;

      try {
        await this.processingCallback(request);
      } catch (error) {
        logger.error('Processing failed', { error, requestId: request.id });
      } finally {
        this.release();
      }
    }, 1000); // Check every second
  }

  stopProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }
}
