import Dockerode = require('dockerode');
import { PoolConfig, ContainerInfo } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('container-pool');

export class ContainerPool {
  private containers: Map<string, ContainerInfo> = new Map();
  private docker: Dockerode;
  private config: PoolConfig;
  private idleChecker: ReturnType<typeof setInterval> | null = null;

  constructor(config: PoolConfig) {
    this.config = config;

    const dockerHost = process.env.DOCKER_HOST || 'tcp://docker-proxy:2375';
    const url = new URL(dockerHost.replace('tcp://', 'http://'));

    this.docker = new Dockerode({
      host: url.hostname,
      port: parseInt(url.port || '2375', 10),
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing container pool', { minSize: this.config.minSize });

    const warmPromises: Promise<string>[] = [];
    for (let i = 0; i < this.config.minSize; i++) {
      warmPromises.push(this.warmContainer());
    }

    const results = await Promise.allSettled(warmPromises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;

    logger.info('Pool initialized', { warmed: succeeded, target: this.config.minSize });

    this.startIdleChecker();
  }

  private async warmContainer(): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.config.image,
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        Binds: [
          `${process.env.CLAUDE_AUTH_PATH || '~/.claude'}:/home/claude/.claude:ro`,
          'repo-cache:/cache/repos:ro',
        ],
        Memory: 2 * 1024 * 1024 * 1024, // 2GB
        NetworkMode: 'internal',
      },
      Labels: {
        'slack-claude-bot': 'true',
        'pool-status': 'idle',
      },
    });

    await container.start();
    const id = container.id;

    this.containers.set(id, {
      id,
      status: 'idle',
      lastActivity: new Date(),
    });

    logger.info('Container warmed', { containerId: id });
    return id;
  }

  async claim(sessionId: string): Promise<ContainerInfo> {
    // Find idle container
    const entries = Array.from(this.containers.entries());
    for (const [id, info] of entries) {
      if (info.status === 'idle') {
        info.status = 'busy';
        info.currentSession = sessionId;
        info.claimedAt = new Date();
        logger.info('Container claimed', { containerId: id, sessionId });
        return info;
      }
    }

    // No idle containers - create new if under max
    if (this.containers.size < this.config.maxSize) {
      const id = await this.warmContainer();
      const info = this.containers.get(id)!;
      info.status = 'busy';
      info.currentSession = sessionId;
      info.claimedAt = new Date();
      return info;
    }

    throw new Error('No containers available - pool exhausted');
  }

  async release(containerId: string): Promise<void> {
    const info = this.containers.get(containerId);
    if (!info) return;

    await this.resetWorkspace(containerId);

    info.status = 'idle';
    info.currentSession = undefined;
    info.claimedAt = undefined;
    info.lastActivity = new Date();

    logger.info('Container released', { containerId });
  }

  private async resetWorkspace(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      const exec = await container.exec({
        Cmd: ['sh', '-c', 'rm -rf /workspace/*'],
        AttachStdout: false,
        AttachStderr: false,
      });
      await exec.start({});
    } catch (error) {
      logger.error('Failed to reset workspace', { containerId, error });
    }
  }

  getContainer(containerId: string): ContainerInfo | undefined {
    return this.containers.get(containerId);
  }

  async acquireFresh(): Promise<ContainerInfo> {
    const id = await this.warmContainer();
    return this.containers.get(id)!;
  }

  private startIdleChecker(): void {
    this.idleChecker = setInterval(async () => {
      const now = Date.now();
      const entries = Array.from(this.containers.entries());
      for (const [id, info] of entries) {
        if (info.status === 'busy' && info.claimedAt) {
          const idleTime = now - info.lastActivity.getTime();
          if (idleTime > this.config.idleTimeout) {
            logger.warn('Container idle timeout', { containerId: id });
            await this.release(id);
          }
        }
      }
    }, 60 * 1000);
  }

  async shutdown(): Promise<void> {
    if (this.idleChecker) clearInterval(this.idleChecker);

    const entries = Array.from(this.containers.entries());
    for (const [id] of entries) {
      try {
        const container = this.docker.getContainer(id);
        await container.stop();
        await container.remove();
      } catch (error) {
        logger.error('Failed to stop container', { containerId: id, error });
      }
    }

    this.containers.clear();
    logger.info('Pool shut down');
  }

  getPoolStatus(): { total: number; idle: number; busy: number; unhealthy: number } {
    let idle = 0, busy = 0, unhealthy = 0;
    const values = Array.from(this.containers.values());
    for (const info of values) {
      if (info.status === 'idle') idle++;
      else if (info.status === 'busy') busy++;
      else if (info.status === 'unhealthy') unhealthy++;
    }
    return { total: this.containers.size, idle, busy, unhealthy };
  }
}
