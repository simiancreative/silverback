import { describe, it, expect } from 'vitest';
import { validateToken, generateToken, matchToolPattern, isToolAllowed, resolveAllowedTools } from '../token';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-secret-key-for-unit-tests';

describe('token', () => {
  describe('generateToken + validateToken roundtrip', () => {
    it('generates and validates a token successfully', () => {
      const token = generateToken(TEST_SECRET, 'ross', 'dev', ['list_*', 'get_*'], 3600);
      const claims = validateToken(token, TEST_SECRET);
      expect(claims.sub).toBe('ross');
      expect(claims.env).toBe('dev');
      expect(claims.tools).toEqual(['list_*', 'get_*']);
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
    });

    it('accepts TTL of exactly 8 hours', () => {
      const token = generateToken(TEST_SECRET, 'ross', 'dev', ['*'], 28800);
      const claims = validateToken(token, TEST_SECRET);
      expect(claims.sub).toBe('ross');
    });
  });

  describe('validateToken', () => {
    it('rejects expired token', () => {
      const token = jwt.sign(
        { env: 'dev', tools: ['*'] },
        TEST_SECRET,
        { algorithm: 'HS256', subject: 'ross', expiresIn: -1 },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('token expired');
    });

    it('rejects wrong secret', () => {
      const token = generateToken(TEST_SECRET, 'ross', 'dev', ['*'], 3600);
      expect(() => validateToken(token, 'wrong-secret')).toThrow('token invalid');
    });

    it('rejects missing sub', () => {
      const token = jwt.sign(
        { env: 'dev', tools: ['*'] },
        TEST_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('missing required claim: sub');
    });

    it('rejects missing env', () => {
      const token = jwt.sign(
        { tools: ['*'] },
        TEST_SECRET,
        { algorithm: 'HS256', subject: 'ross', expiresIn: 3600 },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('missing required claim: env');
    });

    it('rejects missing tools', () => {
      const token = jwt.sign(
        { env: 'dev' },
        TEST_SECRET,
        { algorithm: 'HS256', subject: 'ross', expiresIn: 3600 },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('missing required claim: tools');
    });

    it('rejects empty tools array', () => {
      const token = jwt.sign(
        { env: 'dev', tools: [] },
        TEST_SECRET,
        { algorithm: 'HS256', subject: 'ross', expiresIn: 3600 },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('missing required claim: tools');
    });

    it('rejects TTL > 8 hours', () => {
      const iat = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        { env: 'dev', tools: ['*'], iat, exp: iat + 28801 },
        TEST_SECRET,
        { algorithm: 'HS256', subject: 'ross' },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('exceeds maximum');
    });

    it('rejects wrong algorithm', () => {
      const token = jwt.sign(
        { env: 'dev', tools: ['*'] },
        TEST_SECRET,
        { algorithm: 'HS384', subject: 'ross', expiresIn: 3600 },
      );
      expect(() => validateToken(token, TEST_SECRET)).toThrow('token invalid');
    });
  });

  describe('generateToken', () => {
    it('rejects TTL > 8 hours', () => {
      expect(() => generateToken(TEST_SECRET, 'ross', 'dev', ['*'], 28801)).toThrow('exceeds maximum');
    });

    it('rejects TTL <= 0', () => {
      expect(() => generateToken(TEST_SECRET, 'ross', 'dev', ['*'], 0)).toThrow('must be positive');
    });

    it('rejects empty sub', () => {
      expect(() => generateToken(TEST_SECRET, '', 'dev', ['*'], 3600)).toThrow('sub is required');
    });

    it('rejects empty tools', () => {
      expect(() => generateToken(TEST_SECRET, 'ross', 'dev', [], 3600)).toThrow('tools is required');
    });
  });

  describe('matchToolPattern', () => {
    it('matches exact tool name', () => {
      expect(matchToolPattern('raw_sql_query', 'raw_sql_query')).toBe(true);
    });

    it('does not match different tool name', () => {
      expect(matchToolPattern('raw_sql_query', 'list_tables')).toBe(false);
    });

    it('matches wildcard *', () => {
      expect(matchToolPattern('*', 'anything')).toBe(true);
      expect(matchToolPattern('*', '')).toBe(true);
    });

    it('matches prefix wildcard', () => {
      expect(matchToolPattern('list_*', 'list_tables')).toBe(true);
      expect(matchToolPattern('list_*', 'list_schemas')).toBe(true);
      expect(matchToolPattern('list_*', 'list_')).toBe(true);
    });

    it('does not match non-prefix', () => {
      expect(matchToolPattern('list_*', 'get_tables')).toBe(false);
      expect(matchToolPattern('list_*', 'raw_sql_query')).toBe(false);
    });
  });

  describe('isToolAllowed', () => {
    it('returns true when any pattern matches', () => {
      expect(isToolAllowed('list_tables', ['list_*', 'get_*'])).toBe(true);
    });

    it('returns false when no pattern matches', () => {
      expect(isToolAllowed('raw_sql_query', ['list_*', 'get_*'])).toBe(false);
    });

    it('returns true for wildcard', () => {
      expect(isToolAllowed('anything', ['*'])).toBe(true);
    });
  });

  describe('resolveAllowedTools', () => {
    const available = ['list_tables', 'list_schemas', 'get_table_details', 'raw_sql_query', 'datalake_list_objects'];

    it('resolves single pattern', () => {
      const result = resolveAllowedTools(['list_*'], available);
      expect(result).toEqual(new Set(['list_tables', 'list_schemas']));
    });

    it('resolves multiple patterns', () => {
      const result = resolveAllowedTools(['list_*', 'raw_sql_query'], available);
      expect(result).toEqual(new Set(['list_tables', 'list_schemas', 'raw_sql_query']));
    });

    it('wildcard matches all', () => {
      const result = resolveAllowedTools(['*'], available);
      expect(result).toEqual(new Set(available));
    });

    it('no matches returns empty set', () => {
      const result = resolveAllowedTools(['nonexistent_*'], available);
      expect(result).toEqual(new Set());
    });
  });
});
