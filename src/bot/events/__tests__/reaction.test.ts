import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerReactionHandler } from '../reaction';

vi.mock('../../../git/pr', () => ({
  PRManager: {
    getStatus: vi.fn(),
    merge: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  Logger: class {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { PRManager } from '../../../git/pr';

function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({}),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
    },
  };
}

function createMockEvent(overrides: Record<string, unknown> = {}) {
  return {
    reaction: 'approved',
    item: {
      type: 'message',
      channel: 'C123',
      ts: '1234567890.000001',
    },
    ...overrides,
  };
}

describe('registerReactionHandler', () => {
  let reactionHandler: Function;
  let mockApp: { event: ReturnType<typeof vi.fn> };
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn> };
  let mockThreadPRManager: { getByThread: ReturnType<typeof vi.fn> };
  let mockThreadCompletionManager: { cleanup: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = {
      event: vi.fn((eventName: string, handler: Function) => {
        if (eventName === 'reaction_added') {
          reactionHandler = handler;
        }
      }),
    };

    mockSessionManager = {
      getSession: vi.fn(),
    };

    mockThreadPRManager = {
      getByThread: vi.fn(),
    };

    mockThreadCompletionManager = {
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    registerReactionHandler(
      mockApp as any,
      mockSessionManager as any,
      mockThreadPRManager as any,
      mockThreadCompletionManager as any,
    );
  });

  it('ignores non-approved reactions', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent({ reaction: 'thumbsup' });

    await reactionHandler({ event, client: mockClient });

    expect(mockSessionManager.getSession).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('ignores non-message items', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent({ item: { type: 'file', channel: 'C123', ts: '1234567890.000001' } });

    await reactionHandler({ event, client: mockClient });

    expect(mockSessionManager.getSession).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when no session exists', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue(null);

    await reactionHandler({ event, client: mockClient });

    expect(mockSessionManager.getSession).toHaveBeenCalledWith('1234567890.000001');
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    expect(mockThreadPRManager.getByThread).not.toHaveBeenCalled();
  });

  it('posts message when no PR mapping found', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue(null);

    await reactionHandler({ event, client: mockClient });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.000001',
      text: 'No PR found for this thread. Use `/sb-deploy` to create a PR first.',
    });
    expect(vi.mocked(PRManager.getStatus)).not.toHaveBeenCalled();
  });

  it('posts message when PR mapping has no prNumber', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/42' });

    await reactionHandler({ event, client: mockClient });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.000001',
      text: 'No PR found for this thread. Use `/sb-deploy` to create a PR first.',
    });
  });

  it('posts message when no workspace path on session', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: null });
    mockThreadPRManager.getByThread.mockResolvedValue({ prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });

    await reactionHandler({ event, client: mockClient });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.000001',
      text: 'Cannot merge: workspace not found for this thread.',
    });
    expect(vi.mocked(PRManager.getStatus)).not.toHaveBeenCalled();
  });

  it('adds :merged: reaction and returns when PR is already merged', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue({ prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });
    vi.mocked(PRManager.getStatus).mockResolvedValue('MERGED');

    await reactionHandler({ event, client: mockClient });

    expect(vi.mocked(PRManager.getStatus)).toHaveBeenCalledWith('/workspace', 42);
    expect(mockClient.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1234567890.000001',
      name: 'merged',
    });
    expect(vi.mocked(PRManager.merge)).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    expect(mockThreadCompletionManager.cleanup).not.toHaveBeenCalled();
  });

  it('does not throw when already_reacted on merged PR', async () => {
    const mockClient = createMockClient();
    mockClient.reactions.add.mockRejectedValue(new Error('already_reacted'));
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue({ prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });
    vi.mocked(PRManager.getStatus).mockResolvedValue('MERGED');

    await expect(reactionHandler({ event, client: mockClient })).resolves.not.toThrow();
  });

  it('posts error message when PR is closed', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue({ prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });
    vi.mocked(PRManager.getStatus).mockResolvedValue('CLOSED');

    await reactionHandler({ event, client: mockClient });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.000001',
      text: 'Cannot merge: PR #42 is closed.',
    });
    expect(vi.mocked(PRManager.merge)).not.toHaveBeenCalled();
    expect(mockThreadCompletionManager.cleanup).not.toHaveBeenCalled();
  });

  it('merges PR, adds reaction, posts confirmation, and calls cleanup on happy path', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue({ prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });
    vi.mocked(PRManager.getStatus).mockResolvedValue('OPEN');
    vi.mocked(PRManager.merge).mockResolvedValue(undefined);

    await reactionHandler({ event, client: mockClient });

    expect(vi.mocked(PRManager.merge)).toHaveBeenCalledWith('/workspace', 42);
    expect(mockClient.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1234567890.000001',
      name: 'merged',
    });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.000001',
      text: 'PR #42 merged. :merged:',
    });
    expect(mockThreadCompletionManager.cleanup).toHaveBeenCalledWith('1234567890.000001');
  });

  it('posts error message when merge throws', async () => {
    const mockClient = createMockClient();
    const event = createMockEvent();
    mockSessionManager.getSession.mockResolvedValue({ workspacePath: '/workspace' });
    mockThreadPRManager.getByThread.mockResolvedValue({ prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });
    vi.mocked(PRManager.getStatus).mockResolvedValue('OPEN');
    vi.mocked(PRManager.merge).mockRejectedValue(new Error('merge conflict'));

    await reactionHandler({ event, client: mockClient });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.000001',
      text: 'Failed to merge PR #42: merge conflict',
    });
    expect(mockThreadCompletionManager.cleanup).not.toHaveBeenCalled();
  });
});
