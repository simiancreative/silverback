import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../logging/logger';

const execAsync = promisify(exec);
const logger = new Logger('repo-cache');

export class RepoCache {
  private readonly cacheBase: string;

  constructor(cacheBase = '/cache/repos') {
    this.cacheBase = cacheBase;
  }

  async ensureCached(org: string, repo: string): Promise<string> {
    const cachePath = path.join(this.cacheBase, org, repo);

    try {
      await fs.access(cachePath);
      // Update existing cache
      await execAsync(`git -C ${cachePath} fetch --all --prune`);
      logger.info('Repo cache updated', { org, repo });
    } catch {
      // First time: bare clone
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await execAsync(`git clone --bare git@github.com:${org}/${repo}.git ${cachePath}`);
      logger.info('Repo cache created', { org, repo });
    }

    return cachePath;
  }

  async createWorkspace(threadId: string, org: string, repo: string, branch?: string): Promise<string> {
    const cachePath = await this.ensureCached(org, repo);
    const workspacePath = `/workspace/${threadId}`;

    await execAsync(
      `git clone --reference ${cachePath} git@github.com:${org}/${repo}.git ${workspacePath}`
    );

    if (branch) {
      await execAsync(`git -C ${workspacePath} checkout -b ${branch}`);
    }

    logger.info('Workspace created', { threadId, org, repo, branch });
    return workspacePath;
  }

  async cleanupWorkspace(threadId: string): Promise<void> {
    const workspacePath = `/workspace/${threadId}`;
    await fs.rm(workspacePath, { recursive: true, force: true });
    logger.info('Workspace cleaned up', { threadId });
  }
}
