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
import { RequestQueue } from './queue/request-queue';
import { SessionManager } from './orchestrator/session';
import { RedisStore } from './store/redis';
import { ThreadPRManager } from './manager/thread-pr';
import { AuthVerifier } from './auth/verifier';
import { StreamHandler } from './stream/handler';
import { StreamParser } from './stream/parser';
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
  const store = new RedisStore(process.env.REDIS_URL || 'redis://localhost:6379');

  // Initialize core services
  const queue = new RequestQueue({ maxConcurrent: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '1', 10) });
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

  // Register event handlers
  registerMentionHandler(app, queue);
  registerMessageHandler(app, queue, sessionManager);
  registerChannelJoinHandler(app, workspaceManager, botUserId);

  // Register commands
  const registry = new CommandRegistry(app);
  registry.registerHandler('claude', createClaudeHandler(queue));
  registry.registerHandler('deploy', createDeployHandler(threadPRManager, sessionManager, workspaceManager));
  registry.registerHandler('status', createStatusHandler(queue, auth, executor));
  registry.registerHandler('queue', createQueueHandler(queue));
  registry.registerHandler('connect', createConnectHandler(workspaceManager));

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
      const streamHandler = await StreamHandler.create(client, request.channelId, request.threadId);

      // Set up stream parser
      const parser = new StreamParser();
      parser.on('text', (text: string) => streamHandler.onData(text));

      // Wire claudeSessionId extraction from result event (fixes pre-existing bug)
      parser.on('result', (data: { success?: boolean; session_id?: string }) => {
        if (data?.session_id) {
          sessionManager.updateSession(request.threadId, {
            claudeSessionId: data.session_id,
          }).catch((err) => {
            taskLogger.error('Failed to persist claudeSessionId', { error: err });
          });
        }
      });

      // Execute Claude via executor
      await executor.execute(
        {
          prompt: request.prompt,
          resumeSessionId: session.claudeSessionId || undefined,
          cwd: workspacePath || undefined,
        },
        (chunk: string) => parser.processChunk(chunk),
      );

      // IMPORTANT: flush parser after execute -- result event may be buffered
      parser.flush();

      await streamHandler.complete();

      // Checkpoint context
      await checkpointer.checkpoint({
        threadId: request.threadId,
        sessionId: session.claudeSessionId,
        channelId: request.channelId,
        prompt: request.prompt,
        retryCount: 0,
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

      await failureHandler.handle(error as Error, {
        threadId: request.threadId,
        channelId: request.channelId,
        sessionId: '',
        prompt: request.prompt,
        retryCount: 0,
      });
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
