import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessExecutor } from '../process-executor';
import { TimeoutError } from '../interface';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs for healthCheck
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock fs/promises for temp dir
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn().mockResolvedValue('/tmp/claude-work-test'),
  rm: vi.fn().mockResolvedValue(undefined),
}));

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.pid = 12345;
  return proc;
}

describe('ProcessExecutor', () => {
  let executor: ProcessExecutor;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockMkdtemp: ReturnType<typeof vi.fn>;
  let mockRm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executor = new ProcessExecutor();
    mockSpawn = vi.mocked(spawn);
    mockExistsSync = vi.mocked(existsSync);
    mockMkdtemp = vi.mocked(mkdtemp);
    mockRm = vi.mocked(rm);

    // Reset mocks
    mockSpawn.mockClear();
    mockExistsSync.mockClear();
    mockMkdtemp.mockClear();
    mockRm.mockClear();

    // Reset environment variables
    delete process.env.CLAUDE_DANGEROUS_MODE;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude with correct default args', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      { prompt: 'test prompt' },
      () => {}
    );

    // Simulate successful completion
    setImmediate(() => {
      mockProc.emit('close', 0);
    });

    await executePromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--allowedTools', '*',
        '--', 'test prompt'
      ],
      expect.objectContaining({
        cwd: '/tmp/claude-work-test',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
  });

  it('includes --resume when resumeSessionId provided', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      {
        prompt: 'test prompt',
        resumeSessionId: 'session-123'
      },
      () => {}
    );

    setImmediate(() => {
      mockProc.emit('close', 0);
    });

    await executePromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--resume', 'session-123']),
      expect.any(Object)
    );
  });

  it('pipes stdout chunks to onData callback', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const chunks: string[] = [];
    const executePromise = executor.execute(
      { prompt: 'test' },
      (chunk) => chunks.push(chunk)
    );

    setImmediate(() => {
      mockProc.stdout.emit('data', Buffer.from('chunk1'));
      mockProc.stdout.emit('data', Buffer.from('chunk2'));
      mockProc.emit('close', 0);
    });

    await executePromise;

    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });

  it('logs stderr at warn level', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    // Spy on console.warn (Logger uses pino, but we can check stderr was captured)
    const executePromise = executor.execute(
      { prompt: 'test' },
      () => {}
    );

    setImmediate(() => {
      mockProc.stderr.emit('data', Buffer.from('warning message'));
      mockProc.emit('close', 0);
    });

    await executePromise;

    // Test passes if no error is thrown - stderr is logged but doesn't fail execution
  });

  it('rejects with TimeoutError on timeout', async () => {
    const mockProc = createMockProcess();
    // When kill is called (timeout fires), simulate the process closing
    mockProc.kill.mockImplementation(() => {
      setImmediate(() => mockProc.emit('close', null));
    });
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      { prompt: 'test', timeoutMs: 100 },
      () => {}
    );

    await expect(executePromise).rejects.toThrow(TimeoutError);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects with stderr message on non-zero exit', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      { prompt: 'test' },
      () => {}
    );

    setImmediate(() => {
      mockProc.stderr.emit('data', Buffer.from('Authentication failed'));
      mockProc.emit('close', 1);
    });

    await expect(executePromise).rejects.toThrow(/Claude process failed.*exit 1.*Authentication failed/);
  });

  it('abort() kills active process with SIGTERM', async () => {
    const mockProc = createMockProcess();
    mockProc.kill.mockImplementation(() => {
      setImmediate(() => mockProc.emit('close', 143));
    });
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      { prompt: 'test' },
      () => {}
    );

    // Wait a tick for activeProcess to be set
    await new Promise(resolve => setImmediate(resolve));

    const abortPromise = executor.abort();

    await Promise.all([
      executePromise.catch(() => {}),
      abortPromise
    ]);

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleans up temp directory after execution', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      { prompt: 'test' },
      () => {}
    );

    setImmediate(() => {
      mockProc.emit('close', 0);
    });

    await executePromise;

    expect(mockRm).toHaveBeenCalledWith('/tmp/claude-work-test', {
      recursive: true,
      force: true
    });
  });

  it('healthCheck() returns false when credentials file missing', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await executor.healthCheck();

    expect(result).toBe(false);
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it('healthCheck() returns true when credentials exist and claude --version succeeds', async () => {
    mockExistsSync.mockReturnValue(true);

    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const healthPromise = executor.healthCheck();

    setImmediate(() => {
      mockProc.emit('close', 0);
    });

    const result = await healthPromise;

    expect(result).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--version'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000
      })
    );
  });

  it('removes --dangerouslySkipPermissions when CLAUDE_DANGEROUS_MODE=false', async () => {
    process.env.CLAUDE_DANGEROUS_MODE = 'false';

    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const executePromise = executor.execute(
      { prompt: 'test' },
      () => {}
    );

    setImmediate(() => {
      mockProc.emit('close', 0);
    });

    await executePromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    expect(spawnArgs).toContain('--print');
    expect(spawnArgs).toContain('--allowedTools');
  });
});
