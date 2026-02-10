import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecutor } from '../factory';
import { ProcessExecutor } from '../process-executor';

describe('createExecutor', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.EXECUTOR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EXECUTOR = originalEnv;
    } else {
      delete process.env.EXECUTOR;
    }
  });

  it('returns ProcessExecutor when EXECUTOR=process', () => {
    process.env.EXECUTOR = 'process';
    const executor = createExecutor();
    expect(executor).toBeInstanceOf(ProcessExecutor);
  });

  it('returns ProcessExecutor when EXECUTOR is unset (default)', () => {
    delete process.env.EXECUTOR;
    const executor = createExecutor();
    expect(executor).toBeInstanceOf(ProcessExecutor);
  });

  it('throws for EXECUTOR=k8s', () => {
    process.env.EXECUTOR = 'k8s';
    expect(() => createExecutor()).toThrow('K8sExecutor is not yet implemented');
  });

  it('throws for unknown EXECUTOR value', () => {
    process.env.EXECUTOR = 'unknown-backend';
    expect(() => createExecutor()).toThrow('Unknown executor backend: unknown-backend');
  });
});
