import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../logging/logger';

const execAsync = promisify(exec);
const logger = new Logger('git-branch');

export class BranchManager {
  static generateBranchName(threadId: string): string {
    // Sanitize thread ID for branch name (replace dots with dashes)
    const sanitized = threadId.replace(/\./g, '-');
    return `claude/${sanitized}`;
  }

  static async createBranch(workspacePath: string, branchName: string, baseBranch = 'main'): Promise<void> {
    await execAsync(`git -C ${workspacePath} fetch origin ${baseBranch}`);
    await execAsync(`git -C ${workspacePath} checkout -b ${branchName} origin/${baseBranch}`);
    logger.info('Branch created', { branchName, baseBranch, workspacePath });
  }

  static async pushBranch(workspacePath: string, branchName: string): Promise<void> {
    await execAsync(`git -C ${workspacePath} push -u origin ${branchName}`);
    logger.info('Branch pushed', { branchName });
  }

  static async getCurrentBranch(workspacePath: string): Promise<string> {
    const { stdout } = await execAsync(`git -C ${workspacePath} rev-parse --abbrev-ref HEAD`);
    return stdout.trim();
  }
}
