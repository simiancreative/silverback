import { createInterface, Interface } from 'readline';
import type { Readable } from 'stream';
import type { JsonRpcMessage } from '../types';

export const ERR_INSUFFICIENT_SCOPE = -32003;
export const ERR_PARSE_ERROR = -32700;

export function parseMessage(line: string): JsonRpcMessage {
  return JSON.parse(line) as JsonRpcMessage;
}

export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function isRequest(msg: JsonRpcMessage): boolean {
  return msg.method !== undefined && msg.id !== undefined && msg.id !== null;
}

export function isResponse(msg: JsonRpcMessage): boolean {
  return msg.method === undefined && msg.id !== undefined;
}

export function isNotification(msg: JsonRpcMessage): boolean {
  return msg.method !== undefined && (msg.id === undefined || msg.id === null);
}

export function createError(id: number | string | null | undefined, code: number, message: string): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

/**
 * Create an async line iterator from a readable stream using readline.
 */
export function createLineReader(stream: Readable): Interface {
  return createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
}
