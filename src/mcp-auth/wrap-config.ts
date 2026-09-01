import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logging/logger';
import type { McpServerEntry, McpSettingsFile, SilverbackAuthConfig, McpProxyConfig } from '../types';

const log = new Logger('mcp-auth:wrap-config');

/**
 * Load .silverback-auth.json from workspace root.
 * Returns null if file doesn't exist (auth is opt-in per repo).
 */
export function loadAuthConfig(workspacePath: string): SilverbackAuthConfig | null {
  const configPath = path.join(workspacePath, '.silverback-auth.json');
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.servers)) {
    throw new Error('.silverback-auth.json: servers must be an array');
  }
  for (const s of parsed.servers) {
    if (typeof s !== 'string') {
      throw new Error('.silverback-auth.json: servers must be strings');
    }
  }
  return parsed as SilverbackAuthConfig;
}

/**
 * Discover MCP servers from workspace config files.
 * Reads (in order, later overrides earlier):
 *   1. {workspace}/.mcp.json
 *   2. {workspace}/.claude/settings.json
 * Does NOT read .claude/settings.local.json (we're about to write that).
 */
export function discoverMcpServers(workspacePath: string): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {};

  // 1. .mcp.json
  const mcpJsonPath = path.join(workspacePath, '.mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        Object.assign(servers, raw.mcpServers);
      }
    } catch (err) {
      log.warn(`failed to parse .mcp.json: ${(err as Error).message}`);
    }
  }

  // 2. .claude/settings.json
  const settingsPath = path.join(workspacePath, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        Object.assign(servers, raw.mcpServers);
      }
    } catch (err) {
      log.warn(`failed to parse .claude/settings.json: ${(err as Error).message}`);
    }
  }

  return servers;
}

/**
 * Wrap known MCP servers with the auth proxy.
 * Returns a complete McpSettingsFile for settings.local.json, or null if no wrapping needed.
 */
export function wrapMcpServers(options: {
  workspacePath: string;
  proxyBinaryPath: string;
  jwtSecret: string;
  token: string;
}): McpSettingsFile | null {
  const { workspacePath, proxyBinaryPath, jwtSecret, token } = options;

  // Load auth config
  const authConfig = loadAuthConfig(workspacePath);
  if (!authConfig) return null;

  const knownServers = new Set(authConfig.servers);

  // Discover all MCP servers
  const discovered = discoverMcpServers(workspacePath);
  if (Object.keys(discovered).length === 0) {
    log.info('no MCP servers discovered, nothing to wrap');
    return null;
  }

  // Create mcp-auth config directory
  const authDir = path.join(workspacePath, '.claude', 'mcp-auth');
  fs.mkdirSync(authDir, { recursive: true });

  const result: Record<string, McpServerEntry> = {};

  for (const [name, entry] of Object.entries(discovered)) {
    if (knownServers.has(name)) {
      // Write proxy config for this server
      const proxyConfig: McpProxyConfig = {
        command: entry.command,
        args: entry.args || [],
        env: entry.env || {},
      };
      const configPath = path.join(authDir, `${name}.json`);
      fs.writeFileSync(configPath, JSON.stringify(proxyConfig, null, 2));

      // Wrap with proxy
      result[name] = {
        command: 'node',
        args: [proxyBinaryPath, '--config', configPath],
        env: {
          MCP_JWT_SECRET: jwtSecret,
          MCP_TOKEN: token,
        },
      };
      log.info(`wrapped MCP server: ${name}`);
    } else {
      // Pass through unchanged
      result[name] = entry;
    }
  }

  return { mcpServers: result };
}

/**
 * Write settings.local.json to workspace.
 */
export function writeSettingsLocal(workspacePath: string, settings: McpSettingsFile): void {
  const claudeDir = path.join(workspacePath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log.info(`wrote ${settingsPath}`);
}
