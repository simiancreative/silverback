import { Executor } from './interface';
import { ProcessExecutor } from './process-executor';

export function createExecutor(): Executor {
  const backend = process.env.EXECUTOR || 'process';
  switch (backend) {
    case 'process':
      return new ProcessExecutor();
    case 'k8s':
      throw new Error('K8sExecutor is not yet implemented. See Phase 2 plan.');
    default:
      throw new Error(`Unknown executor backend: ${backend}`);
  }
}
