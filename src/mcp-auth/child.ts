import { spawn, ChildProcess } from 'child_process';
import { Logger } from '../logging/logger';

const log = new Logger('mcp-auth:child');

/**
 * Spawn the child MCP server process.
 * Strips MCP_JWT_SECRET and MCP_TOKEN from child environment.
 * Merges config.env and extraEnv into child environment.
 */
export function spawnChild(
  command: string,
  args: string[],
  configEnv: Record<string, string>,
  extraEnv?: Record<string, string>,
): ChildProcess {
  // Build child env: start with process.env, strip secrets, add config + extra
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'MCP_JWT_SECRET' || k === 'MCP_TOKEN') continue;
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, configEnv);
  if (extraEnv) Object.assign(env, extraEnv);

  log.info(`spawning child: ${command} ${args.join(' ')}`);

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });

  child.on('error', (err) => {
    log.error(`child process error: ${err.message}`);
  });

  return child;
}

/**
 * Gracefully shutdown the child process.
 * SIGTERM first, then SIGKILL after timeout.
 */
export function shutdownChild(proc: ChildProcess, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }

    let killed = false;
    const timer = setTimeout(() => {
      if (!killed) {
        log.info('child did not exit, sending SIGKILL');
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.on('exit', (code) => {
      killed = true;
      clearTimeout(timer);
      resolve(code ?? 1);
    });

    proc.kill('SIGTERM');
  });
}
