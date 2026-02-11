import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Executor, ExecutorOptions, ExecutionResult, TimeoutError } from './interface';
import { Logger } from '../logging/logger';

const logger = new Logger('process-executor');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.EXECUTOR_TIMEOUT_MS || '0', 10); // 0 = no timeout
const SIGKILL_GRACE_MS = 5000;

export class ProcessExecutor implements Executor {
  private activeProcess: ChildProcess | null = null;
  private activeTmpDir: string | null = null;

  async execute(
    options: ExecutorOptions,
    onData: (chunk: string) => void,
  ): Promise<ExecutionResult> {
    // Create isolated working directory if cwd not provided
    let tmpDir: string | null = null;
    let cleanupTmpDir = false;

    if (options.cwd) {
      tmpDir = options.cwd;
    } else {
      tmpDir = await mkdtemp(join(tmpdir(), 'claude-work-'));
      cleanupTmpDir = true;
      this.activeTmpDir = tmpDir;
    }

    const model = process.env.CLAUDE_MODEL || 'sonnet';

    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', model,
    ];

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    args.push('--', options.prompt);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Optionally skip --dangerouslySkipPermissions if env var is explicitly 'false'
    const dangerousMode = process.env.CLAUDE_DANGEROUS_MODE !== 'false';
    if (!dangerousMode) {
      const idx = args.indexOf('--dangerously-skip-permissions');
      if (idx !== -1) args.splice(idx, 1);
    }

    return new Promise<ExecutionResult>((resolve, reject) => {
      const proc = spawn('claude', args, {
        cwd: tmpDir!,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;
      let timedOut = false;
      let stderrBuf = '';

      proc.stdout!.on('data', (chunk: Buffer) => {
        onData(chunk.toString());
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf += text;
        logger.warn('claude stderr', { text: text.trim() });

        // Surface critical errors
        const lower = text.toLowerCase();
        if (lower.includes('auth') || lower.includes('credentials') || lower.includes('fatal')) {
          logger.error('Critical stderr from claude process', { text: text.trim() });
        }
      });

      // Timeout handling
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            logger.warn('Execution timeout reached, killing process', { timeoutMs });
            proc.kill('SIGTERM');
            setTimeout(() => {
              if (!proc.killed) {
                proc.kill('SIGKILL');
              }
            }, SIGKILL_GRACE_MS);
          }, timeoutMs)
        : null;

      proc.on('close', async (code) => {
        if (timer) clearTimeout(timer);
        this.activeProcess = null;

        // Clean up tmp dir only if we created it
        if (cleanupTmpDir) {
          await this.cleanupTmpDir();
        }

        if (timedOut) {
          reject(new TimeoutError(timeoutMs));
          return;
        }

        if (code !== 0 && code !== null) {
          const errMsg = stderrBuf.trim() || `Process exited with code ${code}`;
          reject(new Error(`Claude process failed (exit ${code}): ${errMsg}`));
          return;
        }

        resolve({ exitCode: code ?? 0 });
      });

      proc.on('error', async (err) => {
        if (timer) clearTimeout(timer);
        this.activeProcess = null;
        if (cleanupTmpDir) {
          await this.cleanupTmpDir();
        }
        reject(err);
      });
    });
  }

  async healthCheck(): Promise<boolean> {
    // 1. Check auth is available (env token or credentials file)
    const hasEnvToken = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
    if (!hasEnvToken) {
      const credPath = join(process.env.HOME || '/root', '.claude', '.credentials.json');
      if (!existsSync(credPath)) {
        logger.error('No Claude auth found (no env token, no credentials file)', { path: credPath });
        return false;
      }
    }

    // 2. Check claude binary works
    return new Promise<boolean>((resolve) => {
      const proc = spawn('claude', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });

      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  async abort(): Promise<void> {
    if (this.activeProcess) {
      logger.info('Aborting active process');
      this.activeProcess.kill('SIGTERM');

      // Give 5s grace, then SIGKILL
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          if (this.activeProcess && !this.activeProcess.killed) {
            this.activeProcess.kill('SIGKILL');
          }
          resolve();
        }, SIGKILL_GRACE_MS);

        this.activeProcess!.on('close', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });

      this.activeProcess = null;
    }

    await this.cleanupTmpDir();
  }

  async shutdown(): Promise<void> {
    await this.abort();
  }

  private async cleanupTmpDir(): Promise<void> {
    if (this.activeTmpDir) {
      try {
        await rm(this.activeTmpDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn('Failed to clean up tmp dir', { dir: this.activeTmpDir, error: err });
      }
      this.activeTmpDir = null;
    }
  }
}
