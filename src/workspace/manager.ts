import { KeyValueStore } from '../types';
import { RepoCache } from '../repos/cache';
import { BranchManager } from '../git/branch';
import { Logger } from '../logging/logger';

const logger = new Logger('workspace-manager');

interface ChannelRepoMapping {
  channelId: string;
  org: string;
  repo: string;
  connectedAt: Date;
}

export class WorkspaceManager {
  private cacheLocks = new Map<string, Promise<string>>();

  constructor(
    private store: KeyValueStore,
    private repoCache: RepoCache,
  ) {}

  /**
   * Parse a GitHub repo URL from a Slack channel topic.
   * Supports: github.com/org/repo, https://github.com/org/repo, github.com/org/repo.git
   * SECURITY: Rejects path traversal attempts and invalid characters.
   */
  static parseRepoFromTopic(topic: string): { org: string; repo: string } | null {
    if (!topic) return null;

    const match = topic.match(/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/);
    if (!match) return null;

    let org = match[1];
    let repo = match[2].replace(/\.git$/, '');

    // Security: reject path traversal
    const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    if (!validName.test(org) || !validName.test(repo)) return null;
    if (org.includes('..') || repo.includes('..')) return null;

    return { org, repo };
  }

  async getChannelRepo(channelId: string): Promise<ChannelRepoMapping | null> {
    return this.store.get<ChannelRepoMapping>(`channel-repo:${channelId}`);
  }

  async setChannelRepo(channelId: string, org: string, repo: string): Promise<void> {
    const mapping: ChannelRepoMapping = {
      channelId, org, repo, connectedAt: new Date(),
    };
    await this.store.set(`channel-repo:${channelId}`, mapping);
  }

  async removeChannelRepo(channelId: string): Promise<void> {
    await this.store.delete(`channel-repo:${channelId}`);
  }

  /**
   * Get or create a workspace for a thread. Creates on first call, reuses on subsequent.
   */
  async getOrCreateWorkspace(threadId: string, channelId: string): Promise<string | null> {
    // Check if workspace already exists in session
    const existing = await this.store.get<{ workspacePath: string }>(`workspace:${threadId}`);
    if (existing) return existing.workspacePath;

    // Get channel-repo mapping
    const mapping = await this.getChannelRepo(channelId);
    if (!mapping) {
      // No repo connected — still give the thread a STABLE empty workspace so
      // Claude session `--resume` works across messages (sessions are scoped to
      // the working directory). Without this, each message gets a fresh temp dir
      // and follow-up `--resume` fails with exit 1.
      const workspacePath = await this.repoCache.createEmptyWorkspace(threadId);
      await this.store.set(`workspace:${threadId}`, { workspacePath }, 7 * 24 * 60 * 60 * 1000);
      return workspacePath;
    }

    // Ensure bare cache is ready (with per-repo lock to prevent races)
    const cachePath = await this.ensureCachedWithLock(mapping.org, mapping.repo);
    const branch = BranchManager.generateBranchName(threadId);
    const workspacePath = await this.repoCache.createWorkspace(threadId, mapping.org, mapping.repo, branch, cachePath);

    // Store workspace path
    await this.store.set(`workspace:${threadId}`, { workspacePath }, 7 * 24 * 60 * 60 * 1000); // 7 day TTL

    return workspacePath;
  }

  /**
   * Pre-warm the bare cache for a repo. Public method for channel-join handler.
   */
  async prewarmCache(org: string, repo: string): Promise<void> {
    await this.ensureCachedWithLock(org, repo);
  }

  async cleanupWorkspace(threadId: string): Promise<void> {
    await this.repoCache.cleanupWorkspace(threadId);
    await this.store.delete(`workspace:${threadId}`);
  }

  /**
   * Per-repo mutex to prevent concurrent bare cache operations.
   */
  private async ensureCachedWithLock(org: string, repo: string): Promise<string> {
    const key = `${org}/${repo}`;
    const existing = this.cacheLocks.get(key);
    if (existing) return existing;

    const promise = this.repoCache.ensureCached(org, repo).finally(() => {
      this.cacheLocks.delete(key);
    });
    this.cacheLocks.set(key, promise);
    return promise;
  }
}
