import { describe, it, expect, vi } from 'vitest';
import { WorkspaceManager } from '../manager';
import type { RepoCache } from '../../repos/cache';
import type { KeyValueStore } from '../../types';

function makeStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (data.get(k) ?? null) as T | null,
    set: async (k: string, v: unknown) => { data.set(k, v); },
    delete: async (k: string) => { data.delete(k); },
  } as unknown as KeyValueStore;
}

describe('WorkspaceManager.parseRepoFromTopic', () => {
  it('parses github.com/org/repo', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/myorg/myrepo');
    expect(result).toEqual({ org: 'myorg', repo: 'myrepo' });
  });

  it('parses https://github.com/org/repo', () => {
    const result = WorkspaceManager.parseRepoFromTopic('https://github.com/myorg/myrepo');
    expect(result).toEqual({ org: 'myorg', repo: 'myrepo' });
  });

  it('parses github.com/org/repo.git (strips .git)', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/myorg/myrepo.git');
    expect(result).toEqual({ org: 'myorg', repo: 'myrepo' });
  });

  it('returns null for empty string', () => {
    const result = WorkspaceManager.parseRepoFromTopic('');
    expect(result).toBeNull();
  });

  it('returns null for non-github URLs', () => {
    const result = WorkspaceManager.parseRepoFromTopic('https://gitlab.com/myorg/myrepo');
    expect(result).toBeNull();
  });

  it('rejects path traversal: github.com/../../../etc', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/../../../etc/passwd');
    expect(result).toBeNull();
  });

  it('rejects org starting with dot: github.com/.hidden/repo', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/.hidden/repo');
    expect(result).toBeNull();
  });

  it('rejects org starting with dash: github.com/-bad/repo', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/-bad/repo');
    expect(result).toBeNull();
  });

  it('handles repo with dots: github.com/org/my.repo.name', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/myorg/my.repo.name');
    expect(result).toEqual({ org: 'myorg', repo: 'my.repo.name' });
  });

  it('handles repo with dashes and underscores: github.com/org/my-repo_name', () => {
    const result = WorkspaceManager.parseRepoFromTopic('github.com/myorg/my-repo_name');
    expect(result).toEqual({ org: 'myorg', repo: 'my-repo_name' });
  });
});

describe('WorkspaceManager.getOrCreateWorkspace (no repo connected)', () => {
  it('returns a STABLE empty workspace (no clone) so --resume works across messages', async () => {
    const store = makeStore();
    const createEmptyWorkspace = vi.fn(async (t: string) => `/ws/${t}`);
    const createWorkspace = vi.fn();
    const repoCache = { createEmptyWorkspace, createWorkspace } as unknown as RepoCache;
    const mgr = new WorkspaceManager(store, repoCache);

    const first = await mgr.getOrCreateWorkspace('thread-1', 'chan-1');
    expect(first).toBe('/ws/thread-1');
    expect(createEmptyWorkspace).toHaveBeenCalledTimes(1);
    expect(createWorkspace).not.toHaveBeenCalled();

    // Second message in the same thread reuses the stored path — not a fresh dir.
    const second = await mgr.getOrCreateWorkspace('thread-1', 'chan-1');
    expect(second).toBe('/ws/thread-1');
    expect(createEmptyWorkspace).toHaveBeenCalledTimes(1);
  });
});
