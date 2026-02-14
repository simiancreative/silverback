import { WebClient } from '@slack/web-api';
import { ThreadPRManager } from '../../manager/thread-pr';
import { ThreadCompletionManager } from '../../manager/thread-completion';
import { SessionManager } from '../../orchestrator/session';
import { WorkspaceManager } from '../../workspace/manager';
import { BranchManager } from '../../git/branch';
import { PRManager } from '../../git/pr';
import { Logger } from '../../logging/logger';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);
const logger = new Logger('deploy-command');

export function createDeployHandler(
  threadPRManager: ThreadPRManager,
  sessionManager: SessionManager,
  workspaceManager: WorkspaceManager,
  threadCompletionManager: ThreadCompletionManager,
  botName: string = 'silverback'
) {
  return async (command: any, client: WebClient): Promise<void> => {
    const channelId = command.channel_id;
    const userId = command.user_id;
    const args = command.text?.trim() || '';

    const threadTs = args.trim();

    if (!threadTs) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: [
          'Usage: `/deploy <thread-timestamp>`',
          '',
          'Run this command with the thread timestamp of the conversation you want to deploy.',
          'A PR will be created and the thread will be marked complete with a :white_check_mark: reaction.',
          '',
          'Example: `/deploy 1234567890.123456`',
        ].join('\n'),
      });
      return;
    }

    // Look up session for this thread
    const session = await sessionManager.getSession(threadTs);
    if (!session || !session.workspacePath) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'No active workspace found for that thread. Make sure Claude has worked on something in that thread first.',
      });
      return;
    }

    // Check if PR already exists for this thread
    const existingMapping = await threadPRManager.getByThread(threadTs);
    if (existingMapping?.prUrl) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `A PR already exists for this thread: ${existingMapping.prUrl}`,
      });
      return;
    }

    const branch = session.branch || BranchManager.generateBranchName(threadTs);

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Deploying branch \`${branch}\`... Checking for changes.`,
    });

    try {
      // Check for changes on the branch
      const { stdout: logOutput } = await execAsync(
        `git -C ${session.workspacePath} log origin/main..${branch} --oneline`
      );

      if (!logOutput.trim()) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: 'No changes to deploy. The branch has no commits compared to main.',
        });
        return;
      }

      // Push the branch
      await BranchManager.pushBranch(session.workspacePath, branch);
      logger.info('Branch pushed', { branch, threadTs });

      // Generate meaningful PR title and body from actual changes using Claude
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Generating PR title and description from changes...',
      });

      const { title: prTitle, body: generatedBody } = await PRManager.generatePRContent(
        session.workspacePath,
        branch,
      );

      // Append Slack thread metadata footer
      const prBody = [
        generatedBody,
        '',
        '---',
        '',
        `*Created by ${botName} from Slack thread \`${threadTs}\` in channel \`${channelId}\`*`,
        '',
        'Generated with Claude Code + oh-my-claudecode',
      ].join('\n');

      const pr = await PRManager.create({
        workspacePath: session.workspacePath,
        title: prTitle,
        body: prBody,
        branch,
        baseBranch: 'main',
        draft: false,
      });

      logger.info('PR created', { prNumber: pr.number, prUrl: pr.url, threadTs });

      // Store PR mapping
      await threadPRManager.createMapping({
        threadId: threadTs,
        channelId,
        claudeSessionId: session.claudeSessionId,
        prNumber: pr.number,
        prUrl: pr.url,
        branch,
      });

      // Update session with PR info
      await sessionManager.updateSession(threadTs, {
        prNumber: pr.number,
        prUrl: pr.url,
      });

      // Post success message
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `PR created: ${pr.url}\n\nBranch \`${branch}\` pushed to \`${session.repository}\`.`,
      });

      // Mark thread as complete: add ✅ reaction and clean up resources
      await threadCompletionManager.markComplete(client, channelId, threadTs);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Deploy failed', { threadTs, error });

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Deploy failed: ${errMsg}`,
      });
    }
  };
}
