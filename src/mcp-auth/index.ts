import { Logger } from '../logging/logger';
import { validateToken } from './token';
import { loadConfig } from './config';
import { spawnChild, shutdownChild } from './child';
import { runProxy } from './proxy';

const log = new Logger('mcp-auth');

async function main() {
  // Parse --config flag
  const configIdx = process.argv.indexOf('--config');
  if (configIdx === -1 || configIdx + 1 >= process.argv.length) {
    log.error('usage: silverback-auth --config <path>');
    process.exit(1);
  }
  const configPath = process.argv[configIdx + 1];

  // Load config
  const config = loadConfig(configPath);

  // Check auth mode
  const jwtSecret = process.env.MCP_JWT_SECRET;
  const bypass = !jwtSecret;

  let toolPatterns: string[] | null = null;
  let mcpEnv: string | undefined;

  if (!bypass) {
    const token = process.env.MCP_TOKEN;
    if (!token) {
      log.error('MCP_JWT_SECRET is set but MCP_TOKEN is missing');
      process.exit(1);
    }

    try {
      const claims = validateToken(token, jwtSecret!);
      toolPatterns = claims.tools;
      mcpEnv = claims.env;
      log.info(`auth mode: sub=${claims.sub} env=${claims.env} tools=${claims.tools.join(',')}`);
      if (claims.tools.includes('*')) {
        log.warn('token grants full tool access (wildcard *)');
      }
    } catch (err: unknown) {
      log.error(`token validation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    log.info('bypass mode: no authentication');
  }

  // Build extra env for child
  const extraEnv: Record<string, string> = {};
  if (mcpEnv) {
    extraEnv.MCP_ENV = mcpEnv;
  }

  // Spawn child process
  const child = spawnChild(config.command, config.args, config.env, extraEnv);

  // Handle signals
  let shuttingDown = false;
  const handleSignal = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${sig}, shutting down`);
    const code = await shutdownChild(child);
    process.exit(code);
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // Handle child exit
  child.on('exit', (code) => {
    log.info(`child exited with code ${code}`);
    process.exit(code ?? 1);
  });

  // Run proxy
  try {
    await runProxy({
      clientIn: process.stdin,
      clientOut: process.stdout,
      serverIn: child.stdin!,
      serverOut: child.stdout!,
      toolPatterns,
      bypass,
    });
  } catch (err: unknown) {
    log.error(`proxy error: ${(err as Error).message}`);
  }

  // If proxy ends, shutdown child
  if (!shuttingDown) {
    const code = await shutdownChild(child);
    process.exit(code);
  }
}

main().catch((err) => {
  console.error(`[silverback-auth] fatal: ${err.message}`);
  process.exit(1);
});
