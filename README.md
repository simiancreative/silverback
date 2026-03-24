# SilverBack

A Slack bot that integrates with Anthropic's Claude Code CLI, enabling teams to interact with Claude Code directly from Slack threads.

## Features

- Per-thread isolated workspaces with git repository management
- Spawns `claude` CLI processes to handle tasks asynchronously
- Queue-based execution with Redis persistence (falls back to in-memory)
- Full oh-my-claudecode orchestration modes: autopilot, ralph, ultrawork, ecomode, and more
- Responds to slash commands, @mentions, and threaded messages
- Docker and bare-metal deployment options

## Prerequisites

- Node.js 22+
- pnpm
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Slack app with Socket Mode enabled and the required bot scopes

## Quick Start

### Docker

```bash
cp .env.example .env
# Edit .env with your credentials

docker compose up -d
```

### Bare Metal

```bash
pnpm install
cp .env.example .env
# Edit .env with your credentials

pnpm build
pnpm start
```

To run as a systemd service, copy the provided unit file and enable it:

```bash
sudo cp deploy/silverback.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now silverback
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode (`xapp-...`) |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `REDIS_URL` | No | Redis connection URL. Falls back to in-memory if not set |
| `MAX_CONCURRENT_SESSIONS` | No | Maximum parallel Claude sessions (default: `3`) |
| `EXECUTOR` | No | How to run Claude: `process` (default) or `docker` |

## Slack Commands

| Command | Description |
|---|---|
| `/sb-connect` | Connect the current Slack channel to a git repository |
| `/sb-claude` | Send a one-off prompt to Claude in the current thread |
| `/sb-deploy` | Trigger a deployment task |
| `/sb-status` | Show the status of active sessions and the queue |
| `/sb-queue` | List queued tasks |
| `/sb-autopilot` | Start autopilot mode for autonomous task execution |
| `/sb-plan` | Start a planning session with an interview workflow |
| `/sb-ralph` | Activate persistence mode (runs until complete) |
| `/sb-cancel` | Cancel the active session or queued task in the thread |
| `/sb-ralplan` | Iterative planning with Planner, Architect, and Critic agents |
| `/sb-ultrawork` | Maximum parallel execution mode |
| `/sb-ecomode` | Token-efficient parallel execution mode |
| `/sb-team` | Spawn a coordinated team of agents for a task |

You can also mention the bot (`@SilverBack`) or reply in a thread to interact with Claude directly.

## Architecture

SilverBack uses the `@slack/bolt` library in Socket Mode to receive events without requiring a public HTTP endpoint. When a message is received, it is placed on a queue (backed by Redis when available). A worker pool dequeues tasks and spawns `claude` CLI processes, each isolated in a per-thread workspace directory with its own git state. The oh-my-claudecode plugin is loaded into each Claude session, providing orchestration modes such as autopilot, ralph, and ultrawork. Responses stream back to the originating Slack thread in real time.

## License

MIT
