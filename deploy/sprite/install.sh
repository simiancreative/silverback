#!/bin/bash
set -euo pipefail

echo "=== Slack Claude Bot - Sprite VM Setup ==="

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
command -v redis-cli >/dev/null 2>&1 || { echo "ERROR: redis-cli not found"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI not found"; exit 1; }

CRED_FILE="$HOME/.claude/.credentials.json"
if [ ! -f "$CRED_FILE" ]; then
  echo "ERROR: Claude credentials not found at $CRED_FILE"
  echo "Run 'claude login' first."
  exit 1
fi

# Configure git to use gh for auth
git config --global credential.helper '!gh auth git-credential'

echo "Building..."
cd /home/sprite/slack-claude-bot
npm install
npm run build

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from template -- fill in Slack tokens before starting"
fi

# Create workspace directories
mkdir -p /home/sprite/repos /home/sprite/workspaces

sudo cp deploy/sprite/slack-claude-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable slack-claude-bot

echo ""
echo "Setup complete. To start:"
echo "  1. Edit .env with your Slack tokens"
echo "  2. sudo systemctl start slack-claude-bot"
echo "  3. sudo journalctl -u slack-claude-bot -f"
