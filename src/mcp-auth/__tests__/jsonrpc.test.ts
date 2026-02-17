import { describe, it, expect } from 'vitest';
import { parseMessage, serializeMessage, isRequest, isResponse, isNotification, createError, ERR_INSUFFICIENT_SCOPE, ERR_PARSE_ERROR } from '../jsonrpc';

describe('jsonrpc', () => {
  describe('parseMessage', () => {
    it('parses a request', () => {
      const msg = parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test"}}');
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe(1);
      expect(msg.method).toBe('tools/call');
    });

    it('parses a response', () => {
      const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      expect(msg.id).toBe(1);
      expect(msg.result).toEqual({ tools: [] });
    });

    it('parses a notification', () => {
      const msg = parseMessage('{"jsonrpc":"2.0","method":"notifications/cancelled"}');
      expect(msg.method).toBe('notifications/cancelled');
      expect(msg.id).toBeUndefined();
    });

    it('parses an error response', () => {
      const msg = parseMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"denied"}}');
      expect(msg.error?.code).toBe(-32003);
      expect(msg.error?.message).toBe('denied');
    });

    it('throws on malformed JSON', () => {
      expect(() => parseMessage('not json')).toThrow();
    });
  });

  describe('serializeMessage', () => {
    it('serializes and adds newline', () => {
      const result = serializeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } });
      expect(result).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    });

    it('round-trips correctly', () => {
      const original = { jsonrpc: '2.0', id: 42, method: 'test', params: { x: 1 } };
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized.trim());
      expect(parsed).toEqual(original);
    });
  });

  describe('message classification', () => {
    it('identifies requests', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
      expect(isRequest(msg)).toBe(true);
      expect(isResponse(msg)).toBe(false);
      expect(isNotification(msg)).toBe(false);
    });

    it('identifies responses', () => {
      const msg = { jsonrpc: '2.0', id: 1, result: {} };
      expect(isRequest(msg)).toBe(false);
      expect(isResponse(msg)).toBe(true);
      expect(isNotification(msg)).toBe(false);
    });

    it('identifies notifications', () => {
      const msg = { jsonrpc: '2.0', method: 'notifications/cancelled' };
      expect(isRequest(msg)).toBe(false);
      expect(isResponse(msg)).toBe(false);
      expect(isNotification(msg)).toBe(true);
    });
  });

  describe('createError', () => {
    it('creates a -32003 error', () => {
      const err = createError(1, ERR_INSUFFICIENT_SCOPE, 'tool not permitted');
      expect(err.jsonrpc).toBe('2.0');
      expect(err.id).toBe(1);
      expect(err.error?.code).toBe(-32003);
      expect(err.error?.message).toBe('tool not permitted');
    });

    it('creates a -32700 parse error', () => {
      const err = createError(null, ERR_PARSE_ERROR, 'Parse error');
      expect(err.error?.code).toBe(-32700);
      expect(err.id).toBeNull();
    });
  });
});
