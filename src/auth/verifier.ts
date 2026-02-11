import * as fs from 'fs/promises';
import * as path from 'path';
import { WebClient } from '@slack/web-api';
import { AuthStatus } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('auth-verifier');

export class AuthVerifier {
  private readonly credentialsPath: string;

  constructor(credentialsPath?: string) {
    const home = process.env.HOME || '/root';
    this.credentialsPath = credentialsPath ||
      path.join(process.env.CLAUDE_AUTH_PATH?.replace(/^~/, home) || path.join(home, '.claude'), '.credentials.json');
  }

  async verify(): Promise<AuthStatus> {
    // Check env-based auth first (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { valid: true };
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return { valid: true };
    }

    try {
      const content = await fs.readFile(this.credentialsPath, 'utf-8');
      const raw = JSON.parse(content);

      // Support both flat format and Claude Code's nested claudeAiOauth format
      const creds = raw.claudeAiOauth || raw;

      if (!creds.accessToken) {
        return { valid: false, error: 'No access token found' };
      }

      if (creds.expiresAt && new Date(creds.expiresAt) < new Date()) {
        return { valid: false, error: 'Token expired - re-authentication required' };
      }

      return {
        valid: true,
        expiresAt: creds.expiresAt ? new Date(creds.expiresAt) : undefined
      };
    } catch (error: any) {
      return { valid: false, error: `Failed to read credentials: ${error.message}` };
    }
  }

  async notifyOnExpiry(slackClient: WebClient, adminChannel: string): Promise<void> {
    const status = await this.verify();
    if (!status.valid) {
      await slackClient.chat.postMessage({
        channel: adminChannel,
        text: `:warning: Claude authentication expired or invalid!\nError: ${status.error}\n\nTo fix: Run \`claude\` CLI and re-authenticate.`,
      });
      logger.warn('Auth expiry notification sent', { error: status.error });
    }
  }
}
