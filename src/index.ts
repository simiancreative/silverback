import { createApp } from './bot/app';
import { registerMentionHandler } from './bot/events/mention';
import { registerMessageHandler } from './bot/events/message';
import { CommandRegistry } from './bot/commands/registry';
import { createClaudeHandler } from './bot/commands/claude';
import { createDeployHandler } from './bot/commands/deploy';
import { createStatusHandler } from './bot/commands/status';
import { createQueueHandler } from './bot/commands/queue';
import { RequestQueue } from './queue/request-queue';
import { ContainerPool } from './orchestrator/pool';
import { SessionManager } from './orchestrator/session';
import { ContainerHealthChecker } from './orchestrator/health';
import { RedisStore } from './store/redis';
import { ThreadPRManager } from './manager/thread-pr';
import { AuthVerifier } from './auth/verifier';
import { StreamHandler } from './stream/handler';
import { StreamParser } from './stream/parser';
import { FailureHandler } from './recovery/failure-handler';
import { ContextCheckpointer } from './recovery/checkpointer';
import { RepoCache } from './repos/cache';
import { Logger } from './logging/logger';
import { createAuthMiddleware } from './bot/middleware/auth';
import { RateLimiter } from './bot/middleware/rate-limit';
import { ConfigWatcher } from './config/watcher';
import Dockerode = require('dockerode');
import * as path from 'path';

const logger = new Logger('main');

async function main(): Promise<void> {
  logger.info('Starting Slack Claude Bot...');

  // Initialize store
  const store = new RedisStore(process.env.REDIS_URL || 'redis://localhost:6379');

  // Initialize core services
  const queue = new RequestQueue({ maxConcurrent: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '1', 10) });
  const auth = new AuthVerifier();
  const pool = new ContainerPool({
    minSize: parseInt(process.env.CONTAINER_POOL_MIN || '5', 10),
    maxSize: parseInt(process.env.CONTAINER_POOL_MAX || '10', 10),
    idleTimeout: parseInt(process.env.CONTAINER_IDLE_TIMEOUT_MS || '1800000', 10),
    image: process.env.CONTAINER_IMAGE || 'claude-code:latest',
  });
  const sessionManager = new SessionManager(store);
  const threadPRManager = new ThreadPRManager(store);
  const repoCache = new RepoCache();
  const failureHandler = new FailureHandler(pool, store);
  const checkpointer = new ContextCheckpointer(store);
  const healthChecker = new ContainerHealthChecker(pool);

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(
    parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
    parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)
  );

  // Initialize Docker client
  const dockerHost = process.env.DOCKER_HOST || 'tcp://docker-proxy:2375';
  const dockerUrl = new URL(dockerHost.replace('tcp://', 'http://'));
  const docker = new Dockerode({
    host: dockerUrl.hostname,
    port: parseInt(dockerUrl.port || '2375', 10)
  });

  // Verify auth on startup
  const authStatus = await auth.verify();
  if (!authStatus.valid) {
    logger.error('Authentication invalid on startup', { error: authStatus.error });
    logger.warn('Bot will start but Claude operations will fail until auth is fixed');
  }

  // Initialize container pool
  await pool.initialize();
  logger.info('Container pool initialized');

  // Start health checker
  healthChecker.start();

  // Create Slack app
  const app = createApp();

  // Register auth middleware
  app.use(createAuthMiddleware());

  // Register event handlers
  registerMentionHandler(app, queue);
  registerMessageHandler(app, queue, sessionManager);

  // Register commands
  const registry = new CommandRegistry(app);
  registry.registerHandler('claude', createClaudeHandler(queue));
  registry.registerHandler('deploy', createDeployHandler(threadPRManager));
  registry.registerHandler('status', createStatusHandler(queue, auth, pool));
  registry.registerHandler('queue', createQueueHandler(queue));

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

    let container;

    try {
      // Get or create session
      let session = await sessionManager.getSession(request.threadId);

      if (session) {
        container = await pool.getContainer(session.containerId);
        if (!container || container.status === 'unhealthy') {
          // Container lost, claim new one
          const newContainer = await pool.claim(request.threadId);
          await sessionManager.updateSession(request.threadId, { containerId: newContainer.id });
          container = newContainer;
        }
      } else {
        container = await pool.claim(request.threadId);
        session = {
          threadId: request.threadId,
          channelId: request.channelId,
          claudeSessionId: '',
          containerId: container.id,
          repository: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await sessionManager.createSession(session);
      }

      // Create stream handler for Slack updates
      const { getWebClient } = await import('./bot/app');
      const client = getWebClient();
      const streamHandler = await StreamHandler.create(client, request.channelId, request.threadId);

      // Execute Claude in container (via Docker exec)
      const parser = new StreamParser();
      parser.on('text', (text: string) => streamHandler.onData(text));

      // Docker exec implementation
      const dockerContainer = docker.getContainer(container.id);

      // Build exec command
      const execCmd = ['claude', '--print', '--output-format', 'stream-json', '--allowedTools', '*'];
      if (session.claudeSessionId) {
        execCmd.push('--resume', session.claudeSessionId);
      }
      execCmd.push(request.prompt);

      const exec = await dockerContainer.exec({
        Cmd: execCmd,
        AttachStdout: true,
        AttachStderr: true,
      });

      const execStream = await exec.start({});

      await new Promise<void>((resolve, reject) => {
        execStream.on('data', (chunk: Buffer) => {
          parser.processChunk(chunk.toString());
        });
        execStream.on('end', () => {
          parser.flush();
          resolve();
        });
        execStream.on('error', reject);
      });

      await streamHandler.complete();

      // Checkpoint context
      await checkpointer.checkpoint({
        threadId: request.threadId,
        sessionId: session.claudeSessionId,
        containerId: container.id,
        channelId: request.channelId,
        prompt: request.prompt,
        retryCount: 0,
      });

      taskLogger.info('Request completed', { threadId: request.threadId });
    } catch (error) {
      taskLogger.error('Request failed', { error, threadId: request.threadId });

      await failureHandler.handle(error as Error, {
        threadId: request.threadId,
        channelId: request.channelId,
        sessionId: '',
        containerId: '',
        prompt: request.prompt,
        retryCount: 0,
      });
    } finally {
      // Release container back to pool
      if (container) {
        await pool.release(container.id);
      }
    }
  });

  // Start queue processing
  queue.startProcessing();

  // Start Slack app
  await app.start();
  logger.info('Slack Claude Bot is running!');

  // Graceful shutdown handler
  const shutdown = async () => {
    logger.info('Shutting down...');
    queue.stopProcessing();
    healthChecker.stop();
    await pool.shutdown();
    await store.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Auth check interval (every 30 min)
  setInterval(async () => {
    const status = await auth.verify();
    if (!status.valid) {
      const { getWebClient } = await import('./bot/app');
      const client = getWebClient();
      await auth.notifyOnExpiry(client, process.env.ADMIN_CHANNEL || '');
    }
  }, 30 * 60 * 1000);
}

main().catch((error) => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
