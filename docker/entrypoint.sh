#!/bin/bash
set -e

# Verify auth is mounted
if [ ! -f "$HOME/.claude/.credentials.json" ]; then
    echo "ERROR: Claude auth not mounted at ~/.claude/.credentials.json" >&2
    echo "Mount your auth directory: -v ~/.claude:/home/claude/.claude:ro" >&2
    exit 1
fi

# CRITICAL: Ensure ANTHROPIC_API_KEY is NOT set
if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "ERROR: ANTHROPIC_API_KEY is set. This will use API billing instead of Max subscription." >&2
    echo "Unset the variable to use Max subscription authentication." >&2
    exit 1
fi

# Verify git is configured
if [ -z "$(git config user.email 2>/dev/null)" ]; then
    git config user.email "${GIT_EMAIL:-claude@bot.local}"
    git config user.name "${GIT_NAME:-Claude Bot}"
fi

# Build Claude command arguments
ARGS=()
ARGS+=("--print")
ARGS+=("--output-format" "stream-json")
ARGS+=("--allowedTools" "*")

# Optional: Resume session
if [ -n "$CLAUDE_SESSION_ID" ]; then
    ARGS+=("--resume" "$CLAUDE_SESSION_ID")
fi

# Optional: Dangerous mode (skip all permissions)
if [ "$CLAUDE_DANGEROUS_MODE" = "true" ]; then
    ARGS+=("--dangerouslySkipPermissions")
fi

# Execute with the provided prompt as LAST positional argument
exec claude "${ARGS[@]}" "$@"
