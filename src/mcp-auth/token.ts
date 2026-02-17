import jwt from 'jsonwebtoken';
import type { McpAuthClaims } from '../types';

const MAX_TTL_SECONDS = 28800; // 8 hours

/**
 * Validate a JWT token using HMAC-SHA256.
 * Enforces required claims (sub, env, tools) and max 8h TTL.
 */
export function validateToken(tokenStr: string, secret: string): McpAuthClaims {
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(tokenStr, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch (err: unknown) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('token expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error(`token invalid: ${err.message}`);
    }
    throw err;
  }

  // Validate required claims
  if (!decoded.sub || typeof decoded.sub !== 'string') {
    throw new Error('missing required claim: sub');
  }
  if (!decoded.env || typeof decoded.env !== 'string') {
    throw new Error('missing required claim: env');
  }
  if (!Array.isArray(decoded.tools) || decoded.tools.length === 0) {
    throw new Error('missing required claim: tools');
  }
  for (const t of decoded.tools) {
    if (typeof t !== 'string') {
      throw new Error('tools claim must be an array of strings');
    }
  }

  // Enforce max TTL
  const iat = decoded.iat;
  const exp = decoded.exp;
  if (iat === undefined || exp === undefined) {
    throw new Error('missing required claims: iat and exp');
  }
  if (exp - iat > MAX_TTL_SECONDS) {
    throw new Error(`token TTL exceeds maximum of ${MAX_TTL_SECONDS} seconds (8 hours)`);
  }

  return {
    sub: decoded.sub,
    env: decoded.env as string,
    tools: decoded.tools as string[],
    iat,
    exp,
  };
}

/**
 * Generate a signed JWT token with HMAC-SHA256.
 */
export function generateToken(
  secret: string,
  sub: string,
  env: string,
  tools: string[],
  ttlSeconds: number,
): string {
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`TTL exceeds maximum of ${MAX_TTL_SECONDS} seconds (8 hours)`);
  }
  if (ttlSeconds <= 0) {
    throw new Error('TTL must be positive');
  }
  if (!sub) throw new Error('sub is required');
  if (!env) throw new Error('env is required');
  if (!tools || tools.length === 0) throw new Error('tools is required');

  return jwt.sign({ env, tools }, secret, {
    algorithm: 'HS256',
    subject: sub,
    expiresIn: ttlSeconds,
  });
}

/**
 * Match a tool name against a glob pattern.
 * Supports: "*" (match all), "prefix_*" (prefix match), exact match.
 */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return pattern === toolName;
}

/**
 * Check if a tool name is allowed by any of the given patterns.
 */
export function isToolAllowed(toolName: string, patterns: string[]): boolean {
  return patterns.some(p => matchToolPattern(p, toolName));
}

/**
 * Resolve which tools from an available list are allowed by the given patterns.
 */
export function resolveAllowedTools(patterns: string[], availableTools: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const tool of availableTools) {
    if (isToolAllowed(tool, patterns)) {
      allowed.add(tool);
    }
  }
  return allowed;
}
