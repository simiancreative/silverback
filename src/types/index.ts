// Slack-related types
export interface SlackMessage {
  type: 'message';
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  team: string;
}

export interface SlackThread {
  channelId: string;
  threadTs: string;
  messages: SlackMessage[];
}


// Task-related types
export interface TaskInfo {
  id: string;
  threadId: string;
  channelId: string;
  userId: string;
  prompt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  queuePosition?: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  retryCount: number;
}

// Session persistence types
export interface SessionMapping {
  threadId: string;
  channelId: string;
  claudeSessionId: string;
  workspacePath?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  repository: string;
  createdAt: Date;
  updatedAt: Date;
}

// Command system types
export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  handler: string;
  options?: CommandOption[];
  permissions?: string[];
  enabled: boolean;
  maps_to_omc?: string;
}

export interface CommandOption {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'user' | 'channel';
  description: string;
  required: boolean;
  default?: unknown;
}

// Stream event types (from Claude Code)
export interface ClaudeStreamEvent {
  type: 'assistant' | 'system' | 'result';
  timestamp?: string;
  // assistant event: contains message with content blocks
  message?: {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  // result event: top-level fields
  session_id?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
}

// Queue types
export interface QueueEntry {
  id: string;
  position: number;
  estimatedWait: number;
}

export interface QueueStatus {
  active: boolean;
  queueLength: number;
  positions: Array<{
    id: string;
    position: number;
    waitTime: number;
  }>;
}

export interface QueuedRequest {
  id: string;
  threadId: string;
  channelId: string;
  userId: string;
  prompt: string;
  enqueuedAt: Date;
  position: number;
}

// Recovery types
export interface ContextCheckpoint {
  threadId: string;
  sessionId: string;
  lastPrompt: string;
  summaryJson: object;
  filesModified: string[];
  createdAt: Date;
}

// Store interface
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

// Auth types
export interface AuthStatus {
  valid: boolean;
  expiresAt?: Date;
  error?: string;
}

// Failure types
export enum FailureType {
  TRANSIENT = 'transient',
  CLAUDE_ERROR = 'claude_error',
  SESSION_CORRUPT = 'session_corrupt',
  AUTH_EXPIRED = 'auth_expired',
}

export interface RecoveryResult {
  success: boolean;
  action: 'retried' | 'escalated' | 'aborted';
  message: string;
}

export interface TaskContext {
  threadId: string;
  channelId: string;
  sessionId: string;
  prompt: string;
  retryCount: number;
  filesModified?: string[];
}

// RecoveryContext is an alias for TaskContext
export type RecoveryContext = TaskContext;

