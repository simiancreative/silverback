FROM node:22-slim AS builder

RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# Prune dev dependencies
RUN pnpm prune --prod

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash bot

# Install oh-my-claudecode plugin as bot user
USER bot
RUN claude plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode.git \
  && claude plugin install oh-my-claudecode@omc
USER root

# Copy Claude config (settings + CLAUDE.md)
COPY --chown=bot:bot config/claude-settings.json /home/bot/.claude/settings.json
COPY --chown=bot:bot CLAUDE.md /home/bot/.claude/CLAUDE.md

WORKDIR /app

COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json .
COPY config/ config/

ENV NODE_ENV=production
ENV DATA_DIR=/app/.data

RUN mkdir -p /app/.data && chown -R bot:bot /app

USER bot

ENTRYPOINT ["node", "dist/index.js"]
