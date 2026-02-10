import { describe, it, expect } from 'vitest';
import { WorkspaceManager } from '../manager';

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
