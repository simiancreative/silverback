import * as fs from 'fs/promises';
import * as path from 'path';
import { WebClient } from '@slack/web-api';
import { AuthStatus } from '../types';
import { Logger } from '../logging/logger';

const logger = new Logger('auth-verifier');

export class AuthVerifier {
  private readonly credentialsPath: string;

  constructor(credentialsPath?: string) {
    this.credentialsPath = credentialsPath ||
      path.join(process.env.CLAUDE_AUTH_PATH || '~/.claude', '.credentials.json');
  }

  async verify(): Promise<AuthStatus> {
    try {
      const content = await fs.readFile(this.credentialsPath, 'utf-8');
      const creds = JSON.parse(content);

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
