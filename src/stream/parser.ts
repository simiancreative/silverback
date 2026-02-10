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
        case 'stream_event':
          if (event.event?.delta?.type === 'text_delta' && event.event.delta.text) {
            this.emit('text', event.event.delta.text);
          } else if (event.event?.delta?.type === 'tool_use') {
            this.emit('tool_use', {
              name: event.event.delta.tool_name,
              input: event.event.delta.input,
            });
          } else if (event.event?.delta?.type === 'tool_result') {
            this.emit('tool_result', event.event.delta);
          }
          break;

        case 'system':
          this.emit('system', event);
          break;

        case 'result':
          this.emit('result', event.result);
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
