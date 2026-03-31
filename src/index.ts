import 'dotenv/config';
import { createApp } from './bot/app';
import { registerMentionHandler } from './bot/events/mention';
import { registerMessageHandler } from './bot/events/message';
import { registerChannelJoinHandler } from './bot/events/channel-join';
import { registerReactionHandler } from './bot/events/reaction';
import { CommandRegistry } from './bot/commands/registry';
import { createClaudeHandler } from './bot/commands/claude';
import { createDeployHandler } from './bot/commands/deploy';
import { createStatusHandler } from './bot/commands/status';
import { createQueueHandler } from './bot/commands/queue';
import { createConnectHandler } from './bot/commands/connect';
import { createOmcHandler, createOmcCancelHandler } from './bot/commands/omc';

import { RequestQueue } from './queue/request-queue';
import { SessionManager } from './orchestrator/session';
import { RedisStore } from './store/redis';
import { MemoryStore } from './store/memory';
import { ThreadPRManager } from './manager/thread-pr';
import { ThreadCompletionManager } from './manager/thread-completion';
import { AuthVerifier } from './auth/verifier';
import { StreamHandler } from './stream/handler';
import { StreamParser } from './stream/parser';
import { FileUploader } from './stream/file-uploader';
import { FailureHandler } from './recovery/failure-handler';
import { ContextCheckpointer } from './recovery/checkpointer';
import { RepoCache } from './repos/cache';
import { WorkspaceManager } from './workspace/manager';
import { createExecutor } from './executor/factory';
import { AbortError } from './executor/interface';
import { HealthChecker } from './orchestrator/health';
import { Logger } from './logging/logger';
import { createAuthMiddleware } from './bot/middleware/auth';
import { RateLimiter } from './bot/middleware/rate-limit';
import { ConfigWatcher } from './config/watcher';
import * as path from 'path';
import { rm } from 'fs/promises';

const logger = new Logger('main');

async function main(): Promise<void> {
  logger.info('Starting Slack Claude Bot...');

  // Initialize store
  const store = process.env.REDIS_URL ? new RedisStore(process.env.REDIS_URL) : new MemoryStore();

  // Initialize core services
  const auth = new AuthVerifier();
  const executor = createExecutor();
  const queue = new RequestQueue(
    { maxConcurrent: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '1', 10) },
    store,
    () => executor.abort(),
  );
  await queue.recoverQueue();
  const sessionManager = new SessionManager(store);
  const threadPRManager = new ThreadPRManager(store);
  const failureHandler = new FailureHandler(store);
  const checkpointer = new ContextCheckpointer(store);
  const healthChecker = new HealthChecker(executor);

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(
    parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
    parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)
  );

  // Verify auth on startup
  const authStatus = await auth.verify();
  if (!authStatus.valid) {
    logger.error('Authentication invalid on startup', { error: authStatus.error });
    logger.warn('Bot will start but Claude operations will fail until auth is fixed');
  }

  // Start health checker
  healthChecker.start();

  // Create Slack app
  const app = createApp();

  // Register auth middleware
  app.use(createAuthMiddleware());

  // Start Slack app (before getting bot user ID)
  await app.start();
  logger.info('Slack app started');

  // Get bot user ID
  const { getWebClient } = await import('./bot/app');
  const client = getWebClient();
  const authTest = await client.auth.test();
  const botUserId = authTest.user_id as string;
  const botName = (authTest.user as string) || 'silverback';
  logger.info('Bot user ID', { botUserId, botName });

  // Initialize repo cache and workspace manager with bot name
  const repoCache = new RepoCache(undefined, undefined, botName);
  const workspaceManager = new WorkspaceManager(store, repoCache);
  const threadCompletionManager = new ThreadCompletionManager(sessionManager, workspaceManager, store);

  // Check for files:write scope needed for markdown file uploads
  let fileUploader: FileUploader | null = null;
  const scopes = ((authTest as any).response_metadata?.scopes as string[]) ?? [];
  if (scopes.includes('files:write')) {
    fileUploader = new FileUploader(client);
    logger.info('File upload enabled (files:write scope present)');
  } else if (scopes.length > 0) {
    logger.warn('Missing files:write scope - structured content will not be uploaded as files. Add files:write to your Slack app OAuth scopes.');
  } else {
    // Some auth.test responses don't include scopes - create uploader optimistically
    fileUploader = new FileUploader(client);
    logger.info('File upload enabled (scope check unavailable, assuming files:write present)');
  }

  // Check for files:read scope needed for text snippet input
  const botToken = process.env.SLACK_BOT_TOKEN || '';
  if (scopes.length > 0 && !scopes.includes('files:read')) {
    logger.warn('Missing files:read scope - text snippet input will not work. Add files:read to your Slack app OAuth scopes.');
  }

  // Register event handlers
  registerMentionHandler(app, queue, botToken);
  registerMessageHandler(app, queue, sessionManager, botToken);
  registerChannelJoinHandler(app, workspaceManager, botUserId);
  registerReactionHandler(app, sessionManager, threadPRManager, threadCompletionManager);

  // Register commands
  const registry = new CommandRegistry(app, workspaceManager);
  registry.registerHandler('sb-claude', createClaudeHandler(queue));
  registry.registerHandler('sb-deploy', createDeployHandler(threadPRManager, sessionManager, workspaceManager, botName));
  registry.registerHandler('sb-status', createStatusHandler(queue, auth, executor, workspaceManager));
  registry.registerHandler('sb-queue', createQueueHandler(queue));
  registry.registerHandler('sb-connect', createConnectHandler(workspaceManager));
  // OMC mode handlers
  registry.registerHandler('sb-autopilot', createOmcHandler(queue, 'sb-autopilot', 'autopilot'));
  registry.registerHandler('sb-ralph', createOmcHandler(queue, 'sb-ralph', 'ralph'));
  registry.registerHandler('sb-plan', createOmcHandler(queue, 'sb-plan', 'plan'));
  registry.registerHandler('sb-ralplan', createOmcHandler(queue, 'sb-ralplan', 'ralplan'));
  registry.registerHandler('sb-ultrawork', createOmcHandler(queue, 'sb-ultrawork', 'ulw'));
  registry.registerHandler('sb-ecomode', createOmcHandler(queue, 'sb-ecomode', 'eco'));
  registry.registerHandler('sb-team', createOmcHandler(queue, 'sb-team', 'team'));
  registry.registerHandler('sb-cancel', createOmcCancelHandler(queue));


  // Load command config
  const configPath = path.resolve(process.env.COMMANDS_CONFIG || './config/commands.yaml');
  await registry.loadFromConfig(configPath);

  // Wire config watcher for hot-reload
  if (process.env.ENABLE_HOT_RELOAD === 'true') {
    const configWatcher = new ConfigWatcher(configPath, async () => {
      await registry.loadFromConfig(configPath);
      logger.info('Commands reloaded');
    });
    configWatcher.start();
  }

  // Set up queue processor
  queue.onProcess(async (request) => {
    const taskLogger = new Logger('task-processor');
    taskLogger.info('Processing request', { threadId: request.threadId, userId: request.userId });

    let streamHandler: StreamHandler | null = null;

    try {
      // Get or create session
      let session = await sessionManager.getSession(request.threadId);

      if (!session) {
        session = {
          threadId: request.threadId,
          channelId: request.channelId,
          claudeSessionId: '',
          repository: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await sessionManager.createSession(session);
      }

      // Get or create workspace for this thread
      const workspacePath = await workspaceManager.getOrCreateWorkspace(request.threadId, request.channelId);
      if (workspacePath && !session.workspacePath) {
        await sessionManager.updateSession(request.threadId, { workspacePath });
      }

      // Create stream handler for Slack updates
      streamHandler = await StreamHandler.create(client, request.channelId, request.threadId, fileUploader ?? undefined);

      // Set up stream parser
      const parser = new StreamParser();
      parser.on('message_start', () => streamHandler?.onMessageStart());
      parser.on('text', (text: string) => streamHandler?.onData(text));

      // Wire claudeSessionId extraction from result event
      let extractedSessionId = session.claudeSessionId || '';
      parser.on('result', (data: { success?: boolean; session_id?: string }) => {
        if (data?.session_id) {
          extractedSessionId = data.session_id;
        }
      });

      let executeSuccess = false;
      try {
        await executor.execute(
          {
            prompt: request.prompt,
            resumeSessionId: session.claudeSessionId || undefined,
            cwd: workspacePath || undefined,
          },
          (chunk: string) => parser.processChunk(chunk),
        );
        executeSuccess = true;
      } catch (execError) {
        // If resume failed due to stale session, retry without resume
        const execMsg = execError instanceof Error ? execError.message : String(execError);
        if (session.claudeSessionId && execMsg.includes('No conversation found')) {
          taskLogger.warn('Stale session ID, retrying without resume', { threadId: request.threadId, staleSessionId: session.claudeSessionId });
          await sessionManager.updateSession(request.threadId, { claudeSessionId: '' });
          extractedSessionId = '';

          // Reset stream handler for fresh attempt
          await streamHandler.complete();
          const retryStreamHandler = await StreamHandler.create(client, request.channelId, request.threadId);
          const retryParser = new StreamParser();
          retryParser.on('message_start', () => retryStreamHandler.onMessageStart());
          retryParser.on('text', (text: string) => retryStreamHandler.onData(text));
          retryParser.on('result', (data: { success?: boolean; session_id?: string }) => {
            if (data?.session_id) {
              extractedSessionId = data.session_id;
            }
          });

          try {
            await executor.execute(
              {
                prompt: request.prompt,
                cwd: workspacePath || undefined,
              },
              (chunk: string) => retryParser.processChunk(chunk),
            );
            retryParser.flush();
            executeSuccess = true;
          } finally {
            await retryStreamHandler.complete();
          }
        } else {
          throw execError;
        }
      }

      if (executeSuccess) {
        // IMPORTANT: flush parser after execute -- result event may be buffered
        parser.flush();
        await streamHandler.complete();
      }

      // Persist extracted sessionId
      if (extractedSessionId && extractedSessionId !== session.claudeSessionId) {
        await sessionManager.updateSession(request.threadId, {
          claudeSessionId: extractedSessionId,
        });
      }

      // Clean up downloaded images directory
      if (request.imageDir) {
        try {
          await rm(request.imageDir, { recursive: true, force: true });
          taskLogger.debug('Cleaned up image directory', { imageDir: request.imageDir });
        } catch {
          // Ignore cleanup errors
        }
      }

      // Checkpoint context with the actual sessionId from this execution
      await checkpointer.checkpoint({
        threadId: request.threadId,
        sessionId: extractedSessionId,
        channelId: request.channelId,
        prompt: request.prompt,
        retryCount: request.retryCount || 0,
      });

      taskLogger.info('Request completed', { threadId: request.threadId });
    } catch (error) {
      taskLogger.error('Request failed', { error, threadId: request.threadId });

      // Clean up downloaded images directory even on failure
      if (request.imageDir) {
        try {
          await rm(request.imageDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }

      // Handle intentional abort (superseded by new message in same thread).
      // Note: the claudeSessionId from this aborted run is intentionally not persisted.
      // The previously saved ID remains in SessionManager. If it becomes stale, the
      // retry-without-resume logic (see "No conversation found" handling above) self-heals.
      if (error instanceof AbortError) {
        taskLogger.info('Request aborted by superseding message', { threadId: request.threadId });
        if (streamHandler) {
          await streamHandler.abort();
        }
        return; // Skip recovery and error messaging - the replacement is already queued
      }

      const currentRetryCount = request.retryCount || 0;
      const result = await failureHandler.handle(error as Error, {
        threadId: request.threadId,
        channelId: request.channelId,
        sessionId: '',
        prompt: request.prompt,
        retryCount: currentRetryCount,
      });

      // Handle image error: strip images and re-enqueue (no raw error shown to user)
      if (result.success && result.action === 'retried_without_images') {
        const { stripImageBlocks } = await import('./bot/utils/prompt-builder');
        const strippedPrompt = stripImageBlocks(request.prompt);

        if (strippedPrompt && strippedPrompt !== request.prompt) {
          taskLogger.info('Retrying without images after image processing failure', { threadId: request.threadId });
          await client.chat.postMessage({
            channel: request.channelId,
            thread_ts: request.threadId,
            text: `:warning: Image could not be processed by the API. Retrying your request without the image attachment.`,
          }).catch((e) => taskLogger.error('Failed to post image warning to Slack', { error: e }));

          await queue.enqueue({
            threadId: request.threadId,
            channelId: request.channelId,
            userId: request.userId,
            prompt: strippedPrompt,
            retryCount: currentRetryCount + 1,
          });
        } else {
          taskLogger.warn('Cannot retry without images: prompt would be empty or unchanged', { threadId: request.threadId });
          await client.chat.postMessage({
            channel: request.channelId,
            thread_ts: request.threadId,
            text: `:x: Image could not be processed and no text content was provided. Please try again with a different image or add a text description.`,
          }).catch((e) => taskLogger.error('Failed to post error to Slack', { error: e }));
        }
      }
      // Re-enqueue if recovery says to retry (standard retry)
      else if (result.success && result.action === 'retried') {
        const errMsg = error instanceof Error ? error.message : String(error);
        await client.chat.postMessage({
          channel: request.channelId,
          thread_ts: request.threadId,
          text: `:x: Error: ${errMsg}`,
        }).catch((e) => taskLogger.error('Failed to post error to Slack', { error: e }));

        if (request.imageDir) {
          taskLogger.warn('Retrying request that had images; image context will be lost', { threadId: request.threadId, imageDir: request.imageDir });
        }
        taskLogger.info('Re-enqueuing request after transient failure', { threadId: request.threadId, retryCount: currentRetryCount + 1 });
        await queue.enqueue({
          threadId: request.threadId,
          channelId: request.channelId,
          userId: request.userId,
          prompt: request.prompt,
          retryCount: currentRetryCount + 1,
        });
      }
      // Non-recoverable error: notify user
      else {
        const errMsg = error instanceof Error ? error.message : String(error);
        await client.chat.postMessage({
          channel: request.channelId,
          thread_ts: request.threadId,
          text: `:x: Error: ${errMsg}`,
        }).catch((e) => taskLogger.error('Failed to post error to Slack', { error: e }));
      }
    }
  });

  // Start queue processing
  queue.startProcessing();

  logger.info('Slack Claude Bot is running!');

  // Graceful shutdown handler
  const shutdown = async () => {
    logger.info('Shutting down...');
    queue.stopProcessing();
    healthChecker.stop();
    await executor.shutdown();
    await store.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Auth check interval (every 30 min)
  setInterval(async () => {
    const status = await auth.verify();
    if (!status.valid) {
      await auth.notifyOnExpiry(client, process.env.ADMIN_CHANNEL || '');
    }
  }, 30 * 60 * 1000);
}

main().catch((error) => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
