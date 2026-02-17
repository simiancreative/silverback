import { describe, it, expect } from 'vitest';
import { spawnChild, shutdownChild } from '../child';

describe('child', () => {
  it('spawns a process and communicates via stdin/stdout', async () => {
    const child = spawnChild('cat', [], {}, {});

    const msg = '{"jsonrpc":"2.0","id":1,"method":"test"}\n';
    child.stdin!.write(msg);
    child.stdin!.end();

    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));

    const code = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1));
    });

    expect(code).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe(msg);
  });

  it('strips MCP_JWT_SECRET and MCP_TOKEN from child env', async () => {
    // Set test env vars
    const origSecret = process.env.MCP_JWT_SECRET;
    const origToken = process.env.MCP_TOKEN;
    process.env.MCP_JWT_SECRET = 'test-secret';
    process.env.MCP_TOKEN = 'test-token';

    try {
      const child = spawnChild('env', [], {}, {});

      const chunks: Buffer[] = [];
      child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));

      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      const output = Buffer.concat(chunks).toString();
      expect(output).not.toContain('MCP_JWT_SECRET=');
      expect(output).not.toContain('MCP_TOKEN=');
    } finally {
      // Restore
      if (origSecret !== undefined) process.env.MCP_JWT_SECRET = origSecret;
      else delete process.env.MCP_JWT_SECRET;
      if (origToken !== undefined) process.env.MCP_TOKEN = origToken;
      else delete process.env.MCP_TOKEN;
    }
  });

  it('merges config and extra env', async () => {
    const child = spawnChild('env', [], { CONFIG_VAR: 'hello' }, { MCP_ENV: 'dev' });

    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));

    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });

    const output = Buffer.concat(chunks).toString();
    expect(output).toContain('CONFIG_VAR=hello');
    expect(output).toContain('MCP_ENV=dev');
  });

  it('returns exit code on shutdown', async () => {
    const child = spawnChild('sleep', ['60'], {}, {});
    const code = await shutdownChild(child, 2000);
    // SIGTERM should cause exit (typically code 143 on Linux, or null -> 1)
    expect(typeof code).toBe('number');
  });
});
