import { EventEmitter } from 'events';
import { ClaudeStreamEvent } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('stream-parser');

export class StreamParser extends EventEmitter {
  private buffer = '';

  processChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.parseLine(line.trim());
    }
  }

  private parseLine(line: string): void {
    try {
      const event: ClaudeStreamEvent = JSON.parse(line);

      switch (event.type) {
        case 'assistant':
          // Claude CLI stream-json: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
          if (event.message?.content) {
            this.emit('message_start');
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                this.emit('text', block.text);
              } else if (block.type === 'tool_use') {
                this.emit('tool_use', {
                  name: block.name,
                  input: block.input,
                });
              } else if (block.type === 'tool_result') {
                this.emit('tool_result', block);
              }
            }
          }
          break;

        case 'system':
          this.emit('system', event);
          break;

        case 'result':
          this.emit('result', event);
          break;

        default:
          this.emit('unknown', event);
      }
    } catch (error) {
      // Skip malformed JSON lines
      logger.debug('Skipping malformed line', { line: line.substring(0, 100) });
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim());
      this.buffer = '';
    }
  }
}
