import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { loadAuthConfig, discoverMcpServers, wrapMcpServers, writeSettingsLocal } from '../wrap-config';

describe('wrap-config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-wrap-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- loadAuthConfig ---

  describe('loadAuthConfig', () => {
    it('returns parsed config when file exists', () => {
      writeFileSync(
        path.join(tempDir, '.silverback-auth.json'),
        JSON.stringify({ servers: ['my-server', 'other-server'] }),
      );
      const config = loadAuthConfig(tempDir);
      expect(config).not.toBeNull();
      expect(config!.servers).toEqual(['my-server', 'other-server']);
    });

    it('returns null when file does not exist', () => {
      const config = loadAuthConfig(tempDir);
      expect(config).toBeNull();
    });

    it('throws when servers is not an array', () => {
      writeFileSync(
        path.join(tempDir, '.silverback-auth.json'),
        JSON.stringify({ servers: 'not-an-array' }),
      );
      expect(() => loadAuthConfig(tempDir)).toThrow('servers must be an array');
    });
  });

  // --- discoverMcpServers ---

  describe('discoverMcpServers', () => {
    it('reads from .mcp.json', () => {
      writeFileSync(
        path.join(tempDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'server-a': { command: 'node', args: ['a.js'] },
          },
        }),
      );
      const servers = discoverMcpServers(tempDir);
      expect(servers['server-a']).toEqual({ command: 'node', args: ['a.js'] });
    });

    it('reads from .claude/settings.json', () => {
      mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.claude', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'server-b': { command: 'python', args: ['b.py'] },
          },
        }),
      );
      const servers = discoverMcpServers(tempDir);
      expect(servers['server-b']).toEqual({ command: 'python', args: ['b.py'] });
    });

    it('.claude/settings.json overrides .mcp.json for same server name', () => {
      writeFileSync(
        path.join(tempDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'shared': { command: 'old-cmd', args: [] },
          },
        }),
      );
      mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.claude', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'shared': { command: 'new-cmd', args: ['--flag'] },
          },
        }),
      );
      const servers = discoverMcpServers(tempDir);
      expect(servers['shared'].command).toBe('new-cmd');
    });

    it('returns empty object when no config files exist', () => {
      const servers = discoverMcpServers(tempDir);
      expect(servers).toEqual({});
    });

    it('handles malformed .mcp.json gracefully (empty result for that source)', () => {
      writeFileSync(path.join(tempDir, '.mcp.json'), 'not valid json {{{');
      const servers = discoverMcpServers(tempDir);
      expect(servers).toEqual({});
    });
  });

  // --- wrapMcpServers ---

  describe('wrapMcpServers', () => {
    const proxyBinaryPath = '/usr/local/bin/mcp-proxy';
    const jwtSecret = 'test-secret';
    const token = 'test-token';

    function makeOptions(extra?: Partial<Parameters<typeof wrapMcpServers>[0]>) {
      return { workspacePath: tempDir, proxyBinaryPath, jwtSecret, token, ...extra };
    }

    function writeAuthConfig(servers: string[]) {
      writeFileSync(
        path.join(tempDir, '.silverback-auth.json'),
        JSON.stringify({ servers }),
      );
    }

    function writeMcpJson(mcpServers: Record<string, unknown>) {
      writeFileSync(
        path.join(tempDir, '.mcp.json'),
        JSON.stringify({ mcpServers }),
      );
    }

    it('known server gets wrapped with proxy binary', () => {
      writeAuthConfig(['my-server']);
      writeMcpJson({ 'my-server': { command: 'node', args: ['server.js'] } });

      const result = wrapMcpServers(makeOptions());
      expect(result).not.toBeNull();
      expect(result!.mcpServers['my-server'].command).toBe('node');
      expect(result!.mcpServers['my-server'].args).toContain(proxyBinaryPath);
    });

    it('unknown server passes through unchanged', () => {
      writeAuthConfig(['known-server']);
      writeMcpJson({
        'unknown-server': { command: 'python', args: ['srv.py'], env: { FOO: 'bar' } },
      });

      const result = wrapMcpServers(makeOptions());
      expect(result).not.toBeNull();
      expect(result!.mcpServers['unknown-server']).toEqual({
        command: 'python',
        args: ['srv.py'],
        env: { FOO: 'bar' },
      });
    });

    it('mix of known and unknown servers', () => {
      writeAuthConfig(['known']);
      writeMcpJson({
        'known': { command: 'node', args: ['k.js'] },
        'unknown': { command: 'ruby', args: ['u.rb'] },
      });

      const result = wrapMcpServers(makeOptions());
      expect(result).not.toBeNull();
      // known is wrapped
      expect(result!.mcpServers['known'].args).toContain(proxyBinaryPath);
      // unknown passes through
      expect(result!.mcpServers['unknown'].command).toBe('ruby');
    });

    it('returns null when .silverback-auth.json does not exist', () => {
      writeMcpJson({ 'server': { command: 'node' } });
      const result = wrapMcpServers(makeOptions());
      expect(result).toBeNull();
    });

    it('returns null when no MCP servers discovered', () => {
      writeAuthConfig(['some-server']);
      // No .mcp.json or .claude/settings.json written
      const result = wrapMcpServers(makeOptions());
      expect(result).toBeNull();
    });

    it('wrapped server has correct command/args/env structure', () => {
      writeAuthConfig(['srv']);
      writeMcpJson({ 'srv': { command: 'node', args: ['index.js'] } });

      const result = wrapMcpServers(makeOptions());
      expect(result).not.toBeNull();
      const wrapped = result!.mcpServers['srv'];
      expect(wrapped.command).toBe('node');
      expect(wrapped.args).toEqual([proxyBinaryPath, '--config', expect.stringContaining('srv.json')]);
      expect(wrapped.env).toEqual({
        MCP_JWT_SECRET: jwtSecret,
        MCP_TOKEN: token,
      });
    });

    it('original server env vars preserved in proxy config file', () => {
      writeAuthConfig(['srv']);
      writeMcpJson({
        'srv': { command: 'node', args: ['index.js'], env: { ORIGINAL_VAR: 'original-value' } },
      });

      wrapMcpServers(makeOptions());

      const configFilePath = path.join(tempDir, '.claude', 'mcp-auth', 'srv.json');
      expect(existsSync(configFilePath)).toBe(true);
      const proxyConfig = JSON.parse(readFileSync(configFilePath, 'utf-8'));
      expect(proxyConfig.env).toEqual({ ORIGINAL_VAR: 'original-value' });
    });

    it('proxy config written to .claude/mcp-auth/{name}.json', () => {
      writeAuthConfig(['target']);
      writeMcpJson({ 'target': { command: 'go', args: ['run', 'main.go'] } });

      wrapMcpServers(makeOptions());

      const configFilePath = path.join(tempDir, '.claude', 'mcp-auth', 'target.json');
      expect(existsSync(configFilePath)).toBe(true);
      const proxyConfig = JSON.parse(readFileSync(configFilePath, 'utf-8'));
      expect(proxyConfig.command).toBe('go');
      expect(proxyConfig.args).toEqual(['run', 'main.go']);
    });
  });

  // --- writeSettingsLocal ---

  describe('writeSettingsLocal', () => {
    it('creates .claude/ directory if needed', () => {
      const settings = { mcpServers: { 'srv': { command: 'node' } } };
      writeSettingsLocal(tempDir, settings);
      expect(existsSync(path.join(tempDir, '.claude'))).toBe(true);
    });

    it('writes valid JSON with mcpServers', () => {
      const settings = {
        mcpServers: {
          'srv': { command: 'node', args: ['index.js'], env: { KEY: 'val' } },
        },
      };
      writeSettingsLocal(tempDir, settings);

      const written = path.join(tempDir, '.claude', 'settings.local.json');
      expect(existsSync(written)).toBe(true);
      const parsed = JSON.parse(readFileSync(written, 'utf-8'));
      expect(parsed.mcpServers['srv']).toEqual({
        command: 'node',
        args: ['index.js'],
        env: { KEY: 'val' },
      });
    });
  });
});
