import { exec, spawn } from 'child_process';
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

  static async generatePRContent(
    workspacePath: string,
    branch: string,
  ): Promise<{ title: string; body: string }> {
    const fallbackTitle = `[Claude] Changes from branch ${branch}`;

    try {
      // Get the diff and log for context
      const [diffResult, logResult] = await Promise.all([
        execAsync(`git -C ${workspacePath} diff origin/main...${branch}`, { maxBuffer: 1024 * 512 }),
        execAsync(`git -C ${workspacePath} log origin/main..${branch} --oneline`, { maxBuffer: 1024 * 128 }),
      ]);

      const diff = diffResult.stdout.trim();
      const commitLog = logResult.stdout.trim();

      if (!diff && !commitLog) {
        return { title: fallbackTitle, body: 'No changes detected.' };
      }

      // Truncate diff if too large (keep first 20k chars)
      const truncatedDiff = diff.length > 20000
        ? diff.substring(0, 20000) + '\n\n... (diff truncated)'
        : diff;

      const prompt = [
        'Generate a PR title and description for the following changes.',
        'Return ONLY valid JSON with exactly two keys: "title" and "body".',
        'The title should be concise (under 72 chars), descriptive, and NOT start with "[Claude]".',
        'The body should be markdown with a ## Summary section explaining what changed and why,',
        'followed by a ## Changes section with bullet points of key changes.',
        'Do not wrap the JSON in markdown code fences.',
        '',
        'Commit log:',
        commitLog,
        '',
        'Diff:',
        truncatedDiff,
      ].join('\n');

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn('claude', ['--print', '--', prompt], {
          cwd: workspacePath,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(new Error('Claude PR generation timed out'));
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Claude exited with code ${code}: ${stderr}`));
          } else {
            resolve(stdout);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Parse JSON response from Claude
      const cleaned = result.trim();
      // Try to extract JSON from the response (handle potential markdown fences)
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('Could not parse JSON from Claude PR response', { response: cleaned.substring(0, 200) });
        return { title: fallbackTitle, body: cleaned };
      }

      const parsed = JSON.parse(jsonMatch[0]) as { title: string; body: string };

      if (!parsed.title || !parsed.body) {
        logger.warn('Claude PR response missing title or body', { parsed });
        return { title: fallbackTitle, body: cleaned };
      }

      return {
        title: `[Claude] ${parsed.title}`,
        body: parsed.body,
      };
    } catch (error) {
      logger.warn('Failed to generate PR content with Claude, using fallback', { error });
      return {
        title: fallbackTitle,
        body: PRManager.buildPRBody('', '', 'Automated changes', 'silverback'),
      };
    }
  }

  static buildPRBody(threadId: string, channelId: string, prompt: string, botName: string = 'silverback'): string {
    return [
      '## Summary',
      '',
      prompt,
      '',
      '---',
      '',
      `*Created by ${botName} from Slack thread \`${threadId}\` in channel \`${channelId}\`*`,
      '',
      'Generated with Claude Code + oh-my-claudecode',
    ].join('\n');
  }
}
