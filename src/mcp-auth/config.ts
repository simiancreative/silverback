import { readFileSync } from 'fs';
import type { McpProxyConfig } from '../types';

export function loadConfig(configPath: string): McpProxyConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    throw new Error(`failed to read config file: ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in config file: ${configPath}`);
  }

  const config = parsed as Record<string, unknown>;

  if (!config.command || typeof config.command !== 'string') {
    throw new Error('config: "command" is required and must be a string');
  }

  return {
    command: config.command,
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: (typeof config.env === 'object' && config.env !== null && !Array.isArray(config.env))
      ? Object.fromEntries(Object.entries(config.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {},
  };
}
