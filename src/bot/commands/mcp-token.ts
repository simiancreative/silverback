import { generateToken } from '../../mcp-auth/token';
import { Logger } from '../../logging/logger';

const logger = new Logger('cmd:mcp-token');

/**
 * Create handler for /sb-mcp-token command.
 * Generates MCP auth tokens for tool access.
 * Usage: /sb-mcp-token <env> <tools_csv> [ttl_hours]
 */
export function createMcpTokenHandler(): (command: any, client: any) => Promise<void> {
  return async (command, client) => {
    const args = (command.text || '').trim().split(/\s+/);

    // Validate MCP_JWT_SECRET is configured
    const jwtSecret = process.env.MCP_JWT_SECRET;
    if (!jwtSecret) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: ':x: MCP authentication is not configured. `MCP_JWT_SECRET` environment variable is not set.',
      });
      return;
    }

    // Parse arguments
    if (args.length < 2 || !args[0]) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: [
          ':key: *MCP Token Generator*',
          '',
          '*Usage:* `/sb-mcp-token <env> <tools> [ttl_hours]`',
          '',
          '*Parameters:*',
          '• `env` - Target environment (e.g., `dev`, `prod`)',
          '• `tools` - Comma-separated tool patterns (e.g., `list_*,get_*,raw_sql_query`)',
          '• `ttl_hours` - Token lifetime in hours (default: 4, max: 8)',
          '',
          '*Examples:*',
          '```',
          '/sb-mcp-token dev list_*,get_* 4',
          '/sb-mcp-token prod * 1',
          '/sb-mcp-token dev raw_sql_query,list_tables',
          '```',
          '',
          ':warning: Tokens block all tools by default. You must specify which tools to allow.',
        ].join('\n'),
      });
      return;
    }

    const env = args[0];
    const toolsCsv = args[1];
    const ttlHours = Math.min(parseFloat(args[2] || '4'), 8);

    if (isNaN(ttlHours) || ttlHours <= 0) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: ':x: Invalid TTL. Must be a positive number (max 8 hours).',
      });
      return;
    }

    const tools = toolsCsv.split(',').map((t: string) => t.trim()).filter(Boolean);
    if (tools.length === 0) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: ':x: At least one tool pattern is required.',
      });
      return;
    }

    // sub is automatically the Slack user ID
    const sub = command.user_id;
    const ttlSeconds = Math.round(ttlHours * 3600);

    try {
      const token = generateToken(jwtSecret, sub, env, tools, ttlSeconds);

      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

      if (tools.includes('*')) {
        logger.warn('token generated with wildcard tool access', { sub, env });
      }

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: [
          ':white_check_mark: *MCP Token Generated*',
          '',
          `*Subject:* ${sub}`,
          `*Environment:* ${env}`,
          `*Tools:* \`${tools.join(', ')}\``,
          `*Expires:* ${expiresAt.toISOString()}`,
          '',
          '```',
          token,
          '```',
          '',
          ':lock: This token is only visible to you.',
        ].join('\n'),
      });

      logger.info('MCP token generated', { sub, env, tools, ttlHours });
    } catch (err) {
      logger.error('Failed to generate MCP token', { error: err });
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `:x: Failed to generate token: ${(err as Error).message}`,
      });
    }
  };
}
