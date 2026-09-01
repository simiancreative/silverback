import type { Readable, Writable } from 'stream';
import { createLineReader, parseMessage, serializeMessage, createError, isRequest, isResponse, ERR_INSUFFICIENT_SCOPE, ERR_PARSE_ERROR } from './jsonrpc';
import { isToolAllowed } from './token';
import { Logger } from '../logging/logger';

const log = new Logger('mcp-auth:proxy');

interface ProxyOptions {
  clientIn: Readable;
  clientOut: Writable;
  serverIn: Writable;
  serverOut: Readable;
  toolPatterns: string[] | null;  // null = bypass mode
  bypass: boolean;
}

/**
 * Run the bidirectional proxy between MCP client and server.
 * Filters tools/call and tools/list based on JWT tool patterns.
 */
export function runProxy(options: ProxyOptions): Promise<void> {
  const { clientIn, clientOut, serverIn, serverOut, toolPatterns, bypass } = options;

  // Write serialization: prevent interleaved writes to clientOut
  let writeChain = Promise.resolve();
  function safeWriteClient(data: string): Promise<void> {
    writeChain = writeChain.then(() => new Promise<void>((resolve, reject) => {
      clientOut.write(data, (err) => err ? reject(err) : resolve());
    }));
    return writeChain;
  }

  // Track pending requests for response correlation
  const pending = new Map<string, string>(); // id -> method

  return new Promise<void>((resolve, reject) => {
    let clientDone = false;
    let serverDone = false;

    function checkDone() {
      if (clientDone && serverDone) resolve();
    }

    // Client -> Server loop
    const clientReader = createLineReader(clientIn);

    clientReader.on('line', async (line: string) => {
      if (bypass) {
        serverIn.write(line + '\n');
        return;
      }

      let msg;
      try {
        msg = parseMessage(line);
      } catch {
        log.warn('malformed JSON from client');
        await safeWriteClient(serializeMessage(createError(null, ERR_PARSE_ERROR, 'Parse error')));
        return;
      }

      // Track request IDs for response correlation
      if (isRequest(msg) && msg.id !== undefined && msg.id !== null) {
        pending.set(String(msg.id), msg.method!);
      }

      // Check tools/call scope
      if (msg.method === 'tools/call') {
        const params = msg.params as Record<string, unknown> | undefined;
        const toolName = params?.name as string | undefined;

        if (toolName && toolPatterns && !isToolAllowed(toolName, toolPatterns)) {
          log.info(`denied tools/call: ${toolName}`);
          const errMsg = createError(msg.id, ERR_INSUFFICIENT_SCOPE, `tool not permitted: ${toolName}`);
          await safeWriteClient(serializeMessage(errMsg));
          // Remove from pending since we handled it
          if (msg.id !== undefined && msg.id !== null) {
            pending.delete(String(msg.id));
          }
          return;
        }
      }

      // Forward to server
      serverIn.write(line + '\n');
    });

    clientReader.on('close', () => {
      clientDone = true;
      // Signal EOF to child
      if (typeof (serverIn as any).end === 'function') {  // eslint-disable-line @typescript-eslint/no-explicit-any
        (serverIn as any).end();  // eslint-disable-line @typescript-eslint/no-explicit-any
      }
      checkDone();
    });

    // Server -> Client loop
    const serverReader = createLineReader(serverOut);

    serverReader.on('line', async (line: string) => {
      if (bypass) {
        await safeWriteClient(line + '\n');
        return;
      }

      let msg;
      try {
        msg = parseMessage(line);
      } catch {
        log.warn('malformed JSON from server');
        await safeWriteClient(serializeMessage(createError(null, ERR_PARSE_ERROR, 'Parse error')));
        return;
      }

      // Check if this is a response to a tracked request
      if (isResponse(msg) && msg.id !== undefined && msg.id !== null) {
        const idStr = String(msg.id);
        const method = pending.get(idStr);
        if (method) {
          pending.delete(idStr);

          // Filter tools/list responses
          if (method === 'tools/list' && msg.result && toolPatterns) {
            try {
              const result = msg.result as { tools?: Array<{ name: string; [key: string]: unknown }> };
              if (result.tools && Array.isArray(result.tools)) {
                result.tools = result.tools.filter(tool =>
                  isToolAllowed(tool.name, toolPatterns)
                );
                msg.result = result;
                await safeWriteClient(serializeMessage(msg));
                return;
              }
            } catch (err) {
              log.warn(`failed to filter tools/list response: ${err}`);
              // Fall through to forward unfiltered
            }
          }
        }
      }

      // Forward to client
      await safeWriteClient(line + '\n');
    });

    serverReader.on('close', () => {
      serverDone = true;
      checkDone();
    });

    // Handle errors
    clientIn.on('error', (err) => {
      log.error(`client input error: ${err.message}`);
      clientDone = true;
      checkDone();
    });

    serverOut.on('error', (err) => {
      log.error(`server output error: ${err.message}`);
      serverDone = true;
      checkDone();
    });
  });
}
