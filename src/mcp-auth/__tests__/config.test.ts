import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mcp-auth-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads a valid config', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      command: './mcp-server',
      args: ['--verbose'],
      env: { VAULT_ADDR: 'http://vault:8200' },
    }));

    const config = loadConfig(configPath);
    expect(config.command).toBe('./mcp-server');
    expect(config.args).toEqual(['--verbose']);
    expect(config.env).toEqual({ VAULT_ADDR: 'http://vault:8200' });
  });

  it('defaults args and env when omitted', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ command: './mcp-server' }));

    const config = loadConfig(configPath);
    expect(config.command).toBe('./mcp-server');
    expect(config.args).toEqual([]);
    expect(config.env).toEqual({});
  });

  it('rejects missing command', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ args: [] }));

    expect(() => loadConfig(configPath)).toThrow('command');
  });

  it('rejects malformed JSON', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, 'not json');

    expect(() => loadConfig(configPath)).toThrow('invalid JSON');
  });

  it('rejects missing file', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow('failed to read');
  });

  it('ignores extra fields', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      command: './mcp-server',
      unknown_field: 'ignored',
      another: 123,
    }));

    const config = loadConfig(configPath);
    expect(config.command).toBe('./mcp-server');
    expect((config as any).unknown_field).toBeUndefined();
  });
});
