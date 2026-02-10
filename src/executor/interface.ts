import { EventEmitter } from 'events';

/**
 * Custom error for execution timeouts.
 * Thrown when the executor kills a process that exceeded its timeoutMs.
 */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export interface ExecutionResult {
  exitCode: number;
}

export interface ExecutorOptions {
  prompt: string;
  resumeSessionId?: string;   // --resume flag
  cwd?: string;                // workspace directory override
  env?: Record<string, string>;
  timeoutMs?: number;          // kill after timeout (default: 10 min)
}

export interface Executor {
  /**
   * Execute Claude CLI with the given options.
   * Calls onData with raw string chunks suitable for StreamParser.processChunk().
   * Returns when the process/job completes.
   *
   * IMPORTANT: Callers MUST call parser.flush() after execute() resolves, because
   * the final `result` event may still be buffered in the parser. Failure to flush
   * means `claudeSessionId` will not be extracted.
   */
  execute(
    options: ExecutorOptions,
    onData: (chunk: string) => void,
  ): Promise<ExecutionResult>;

  /**
   * Health/readiness check. Returns true if the executor backend is available.
   * ProcessExecutor: checks `claude --version` AND ~/.claude/.credentials.json exists.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Abort any running execution. Called on graceful shutdown.
   */
  abort(): Promise<void>;

  /**
   * Clean up resources. Called once on process exit.
   */
  shutdown(): Promise<void>;
}
