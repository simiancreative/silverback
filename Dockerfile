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
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Install Go (supports both amd64 and arm64 architectures)
ARG GO_VERSION=1.24.13
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/bot/go/bin:${PATH}"
ENV GOPATH="/home/bot/go"

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash bot \
  && mkdir -p /home/bot/go \
  && chown bot:bot /home/bot/go

# Install Go development tools (linting + hot-reload)
# Install oh-my-claudecode plugin as bot user
USER bot
RUN go install github.com/golangci/golangci-lint/cmd/golangci-lint@v2.1.6 && \
    go install github.com/air-verse/air@latest
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
