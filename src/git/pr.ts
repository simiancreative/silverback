import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../logging/logger';

const execAsync = promisify(exec);
const logger = new Logger('git-pr');

export interface PRCreateOptions {
  workspacePath: string;
  title: string;
  body: string;
  branch: string;
  baseBranch?: string;
  draft?: boolean;
}

export interface PRInfo {
  number: number;
  url: string;
  title: string;
}

export class PRManager {
  static async create(options: PRCreateOptions): Promise<PRInfo> {
    const { workspacePath, title, body, branch, baseBranch = 'main', draft = false } = options;

    const draftFlag = draft ? '--draft' : '';
    const cmd = `cd ${workspacePath} && gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --head ${branch} --base ${baseBranch} ${draftFlag}`;

    const { stdout } = await execAsync(cmd);
    const prUrl = stdout.trim();
    const prNumber = parseInt(prUrl.split('/').pop() || '0', 10);

    logger.info('PR created', { prNumber, prUrl, branch });

    return {
      number: prNumber,
      url: prUrl,
      title,
    };
  }

  static async merge(workspacePath: string, prNumber: number, squash = true): Promise<void> {
    const squashFlag = squash ? '--squash' : '--merge';
    await execAsync(`cd ${workspacePath} && gh pr merge ${prNumber} ${squashFlag} --delete-branch`);
    logger.info('PR merged', { prNumber, squash });
  }

  static async getStatus(workspacePath: string, prNumber: number): Promise<string> {
    const { stdout } = await execAsync(`cd ${workspacePath} && gh pr view ${prNumber} --json state -q .state`);
    return stdout.trim();
  }

  static buildPRBody(threadId: string, channelId: string, prompt: string): string {
    return [
      '## Summary',
      '',
      prompt,
      '',
      '---',
      '',
      `*Created by Claude Bot from Slack thread \`${threadId}\` in channel \`${channelId}\`*`,
      '',
      'Generated with Claude Code + oh-my-claudecode',
    ].join('\n');
  }
}
