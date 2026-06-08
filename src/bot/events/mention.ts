import { App } from '@slack/bolt';
import { RequestQueue } from '../../queue/request-queue';
import { Logger } from '../../logging/logger';
import { downloadTextFiles, downloadImageFiles, SlackFileInfo } from '../utils/file-downloader';
import { buildPrompt } from '../utils/prompt-builder';
import { fetchThreadMessages } from '../utils/thread-fetcher';
import { isThreadReviewRequest, extractReviewInstruction, buildThreadReviewPrompt } from '../utils/thread-review';
import { tmpdir } from 'os';
import { join } from 'path';

const logger = new Logger('mention-handler');

export function registerMentionHandler(app: App, queue: RequestQueue, botToken: string): void {
  app.event('app_mention', async ({ event, client, say }) => {
    const textPrompt = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    // Extract files if present
    const files: SlackFileInfo[] = 'files' in event && Array.isArray((event as any).files)
      ? (event as any).files
      : [];

    if (!textPrompt && files.length === 0) {
      await say({ text: 'Please provide a task description after mentioning me.', thread_ts: event.ts });
      return;
    }

    const threadTs = event.thread_ts || event.ts;

    // --- Thread review path ---
    if (isThreadReviewRequest(textPrompt)) {
      const threadRoot = event.thread_ts || event.ts;

      // Post a visible status message in-thread
      try {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadRoot,
          text: `:mag: Gathering this thread for review...`,
        });

        const messages = await fetchThreadMessages(client, event.channel, threadRoot);

        // Update the status message with the message count now that we know it
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadRoot,
          text: `:mag: Gathered ${messages.length} messages. Building review prompt...`,
        });

        const allFiles: SlackFileInfo[] = messages.flatMap((m) => m.files);

        const imgDir = join(tmpdir(), `slack-images-${threadTs}`);
        const [downloaded, downloadedImages] = await Promise.all([
          downloadTextFiles(allFiles, botToken, { maxFiles: 10 }),
          downloadImageFiles(allFiles, botToken, imgDir, { maxFiles: 10 }),
        ]);

        let imageDir: string | undefined;
        if (downloadedImages.length > 0) {
          imageDir = imgDir;
        }

        const prompt = buildThreadReviewPrompt({
          instruction: extractReviewInstruction(textPrompt),
          messages,
          files: downloaded,
          images: downloadedImages,
        });

        logger.info('Thread review enqueued', {
          user: event.user,
          channel: event.channel,
          threadRoot,
          messageCount: messages.length,
          fileCount: allFiles.length,
          hasImages: !!imageDir,
        });

        const entry = await queue.enqueue({
          threadId: threadTs as string,
          channelId: event.channel,
          userId: event.user || 'unknown',
          prompt,
          imageDir,
        });

        if (entry.position > 0) {
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: `Your request is queued. Position: ${entry.position}. Estimated wait: ~${Math.ceil(entry.estimatedWait / 60000)} minutes.`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to fetch thread for review', { error: errMsg, channel: event.channel, threadRoot });
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadRoot,
          text: `:x: Couldn't fetch this thread: ${errMsg}`,
        });
      }

      return;
    }

    // --- Normal mention path ---

    // Download text files and images if present
    let prompt = textPrompt;
    let imageDir: string | undefined;
    if (files.length > 0 && botToken) {
      const downloaded = await downloadTextFiles(files, botToken);
      const imgDir = join(tmpdir(), `slack-images-${threadTs}`);
      const downloadedImages = await downloadImageFiles(files, botToken, imgDir);
      if (downloadedImages.length > 0) {
        imageDir = imgDir;
      }
      prompt = buildPrompt(textPrompt, downloaded, downloadedImages);
    }

    logger.info('Received mention', { user: event.user, channel: event.channel, threadTs, fileCount: files.length, hasImages: !!imageDir });

    const entry = await queue.enqueue({
      threadId: threadTs as string,
      channelId: event.channel,
      userId: event.user || 'unknown',
      prompt,
      imageDir,
    });

    if (entry.position > 0) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `Your request is queued. Position: ${entry.position}. Estimated wait: ~${Math.ceil(entry.estimatedWait / 60000)} minutes.`,
      });
    }
  });
}
