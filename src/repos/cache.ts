import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../logging/logger';

const execFileAsync = promisify(execFile);
const logger = new Logger('repo-cache');

function repoUrl(org: string, repo: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
  }
  return repoUrl(org, repo);
}

export class RepoCache {
  private readonly cacheBase: string;
  private readonly workspaceBase: string;
  private readonly botName: string;

  constructor(cacheBase?: string, workspaceBase?: string, botName?: string) {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
    this.cacheBase = cacheBase || path.join(dataDir, 'repos');
    this.workspaceBase = workspaceBase || path.join(dataDir, 'workspaces');
    this.botName = botName || 'silverback';
  }

  async ensureCached(org: string, repo: string): Promise<string> {
    const cachePath = path.join(this.cacheBase, org, `${repo}.git`);

    // Path validation: prevent traversal
    const resolvedCache = path.resolve(cachePath);
    if (!resolvedCache.startsWith(path.resolve(this.cacheBase))) {
      throw new Error('Path traversal detected in cache path');
    }

    try {
      await fs.access(cachePath);
      // Update existing bare cache
      await execFileAsync('git', ['-C', cachePath, 'fetch', '--all', '--prune']);
      logger.info('Repo cache updated', { org, repo });
    } catch {
      // First time: bare clone
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await execFileAsync('git', ['clone', '--bare', repoUrl(org, repo), cachePath]);
      logger.info('Repo cache created', { org, repo });
    }

    return cachePath;
  }

  async createWorkspace(threadId: string, org: string, repo: string, branch?: string): Promise<string> {
    const cachePath = await this.ensureCached(org, repo);
    const workspacePath = path.join(this.workspaceBase, threadId);

    // Path validation: prevent traversal
    const resolvedWorkspace = path.resolve(workspacePath);
    if (!resolvedWorkspace.startsWith(path.resolve(this.workspaceBase))) {
      throw new Error('Path traversal detected in workspace path');
    }

    // Check if workspace already exists (thread reuse)
    try {
      await fs.access(workspacePath);
      logger.info('Workspace already exists, reusing', { threadId, workspacePath });
      return workspacePath;
    } catch {
      // Does not exist, create it
    }

    await fs.mkdir(this.workspaceBase, { recursive: true });
    await execFileAsync('git', ['clone', '--reference', cachePath, repoUrl(org, repo), workspacePath]);

    if (branch) {
      await execFileAsync('git', ['-C', workspacePath, 'checkout', '-b', branch]);
    }

    // Configure git identity
    await execFileAsync('git', ['-C', workspacePath, 'config', 'user.email', `${this.botName}@users.noreply.github.com`]);
    await execFileAsync('git', ['-C', workspacePath, 'config', 'user.name', this.botName]);

    logger.info('Workspace created', { threadId, org, repo, branch, workspacePath });
    return workspacePath;
  }

  async cleanupWorkspace(threadId: string): Promise<void> {
    const workspacePath = path.join(this.workspaceBase, threadId);
    await fs.rm(workspacePath, { recursive: true, force: true });
    logger.info('Workspace cleaned up', { threadId });
  }

  async workspaceExists(threadId: string): Promise<boolean> {
    const workspacePath = path.join(this.workspaceBase, threadId);
    try {
      await fs.access(workspacePath);
      return true;
    } catch {
      return false;
    }
  }
}
