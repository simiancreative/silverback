import 'dotenv/config';
import { createApp } from './bot/app';
import { registerMentionHandler } from './bot/events/mention';
import { registerMessageHandler } from './bot/events/message';
import { registerChannelJoinHandler } from './bot/events/channel-join';
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
import { AuthVerifier } from './auth/verifier';
import { StreamHandler } from './stream/handler';
import { StreamParser } from './stream/parser';
import { FileUploader } from './stream/file-uploader';
import { FailureHandler } from './recovery/failure-handler';
import { ContextCheckpointer } from './recovery/checkpointer';
import { RepoCache } from './repos/cache';
import { WorkspaceManager } from './workspace/manager';
import { createExecutor } from './executor/factory';
import { HealthChecker } from './orchestrator/health';
import { Logger } from './logging/logger';
import { createAuthMiddleware } from './bot/middleware/auth';
import { RateLimiter } from './bot/middleware/rate-limit';
import { ConfigWatcher } from './config/watcher';
import * as path from 'path';

const logger = new Logger('main');

async function main(): Promise<void> {
  logger.info('Starting Slack Claude Bot...');

  // Initialize store
  const store = process.env.REDIS_URL ? new RedisStore(process.env.REDIS_URL) : new MemoryStore();

  // Initialize core services
  const queue = new RequestQueue({ maxConcurrent: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '1', 10) }, store);
  await queue.recoverQueue();
  const auth = new AuthVerifier();
  const executor = createExecutor();
  const sessionManager = new SessionManager(store);
  const threadPRManager = new ThreadPRManager(store);
  const repoCache = new RepoCache();
  const workspaceManager = new WorkspaceManager(store, repoCache);
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
  logger.info('Bot user ID', { botUserId });

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

  // Register event handlers
  registerMentionHandler(app, queue);
  registerMessageHandler(app, queue, sessionManager);
  registerChannelJoinHandler(app, workspaceManager, botUserId);

  // Register commands
  const registry = new CommandRegistry(app, workspaceManager);
  registry.registerHandler('sb-claude', createClaudeHandler(queue));
  registry.registerHandler('sb-deploy', createDeployHandler(threadPRManager, sessionManager, workspaceManager));
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
      const streamHandler = await StreamHandler.create(client, request.channelId, request.threadId, fileUploader ?? undefined);

      // Set up stream parser
      const parser = new StreamParser();
      parser.on('message_start', () => streamHandler.onMessageStart());
      parser.on('text', (text: string) => streamHandler.onData(text));

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

      // Notify user in Slack thread
      const errMsg = error instanceof Error ? error.message : String(error);
      await client.chat.postMessage({
        channel: request.channelId,
        thread_ts: request.threadId,
        text: `:x: Error: ${errMsg}`,
      }).catch((e) => taskLogger.error('Failed to post error to Slack', { error: e }));

      const currentRetryCount = request.retryCount || 0;
      const result = await failureHandler.handle(error as Error, {
        threadId: request.threadId,
        channelId: request.channelId,
        sessionId: '',
        prompt: request.prompt,
        retryCount: currentRetryCount,
      });

      // Re-enqueue if recovery says to retry
      if (result.success && result.action === 'retried') {
        taskLogger.info('Re-enqueuing request after transient failure', { threadId: request.threadId, retryCount: currentRetryCount + 1 });
        await queue.enqueue({
          threadId: request.threadId,
          channelId: request.channelId,
          userId: request.userId,
          prompt: request.prompt,
          retryCount: currentRetryCount + 1,
        });
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
