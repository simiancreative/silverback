# MCP Authentication Proxy (silverback-auth)

The silverback-auth MCP authentication layer is a JWT-based security proxy that sits between Claude Code CLI and any MCP (Model Context Protocol) server. It filters which tools a user can access using glob patterns defined in JWT tokens, providing granular tool-level access control.

## Overview

### What It Is

- **JWT-based authentication proxy** that validates tokens using HMAC-SHA256
- **Tool filtering** via glob patterns in the JWT token claims
- **One proxy per MCP server** — transparent to the LLM (tools remain discoverable)
- **JSON-RPC 2.0 protocol** using newline-delimited messages over stdin/stdout
- **Opt-in per repository** — only servers explicitly listed get wrapped

### Architecture

```
Claude Code CLI  →  silverback-auth proxy  →  MCP Server
   (stdin/stdout)    (validates JWT,         (actual tools)
                      filters tools)
```

The proxy:
1. Reads JSON-RPC messages line-by-line from the client (Claude Code CLI)
2. Validates the JWT token from the environment
3. Intercepts specific JSON-RPC methods to apply tool filtering:
   - `tools/call` — blocks calls to unauthorized tools with error code `-32003`
   - `tools/list` — filters the response to show only authorized tools
4. Forwards all other messages unmodified to the MCP server
5. Returns responses back to the client

### Bypass Mode

When `MCP_JWT_SECRET` environment variable is **not set**, the proxy runs in **bypass mode**:
- All JSON-RPC messages pass through unmodified
- No token validation occurs
- No tool filtering happens
- Useful for local development without authentication

## Prerequisites

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_JWT_SECRET` | Yes (for auth) | HMAC-SHA256 secret for JWT signing and verification. If not set, proxy runs in bypass mode. |
| `MCP_TOKEN` | Yes (when secret set) | The JWT token to validate against the secret. Required when `MCP_JWT_SECRET` is set. |
| `MCP_ENV` | No | Environment identifier passed from the token's `env` claim to the MCP server. |
| `MCP_DEFAULT_TOOLS` | No | Comma-separated default tool patterns for workspace tokens (default: `*`). |

### Configuration Files

The proxy uses two configuration patterns:

1. **`.silverback-auth.json`** (committed to repo) — declares which MCP servers need auth wrapping
2. **`.mcp.json`** or **`.claude/settings.json`** (committed to repo) — standard MCP server definitions

## Step 1: Declare Which MCP Servers Need Auth

Create `.silverback-auth.json` in the repo root to specify which MCP servers should be wrapped with authentication:

```json
{
  "servers": ["vendgogh", "analytics-db"]
}
```

**Key points:**
- Only servers listed here get wrapped with the auth proxy
- Servers not listed pass through unchanged
- If this file doesn't exist, no auth wrapping happens (opt-in per repo)
- The file is committed to version control

In this example:
- `vendgogh` and `analytics-db` will be wrapped with authentication
- Any other MCP servers (e.g., `filesystem`) will pass through without auth

## Step 2: Configure MCP Servers

MCP servers are discovered from these files (later overrides earlier):

1. **`.mcp.json`** (standard MCP config)
2. **`.claude/settings.json`** (Claude project settings)

The proxy reads both files and merges them. It does NOT read `.claude/settings.local.json` (which is generated at runtime).

### Example `.mcp.json`

```json
{
  "mcpServers": {
    "vendgogh": {
      "command": "npx",
      "args": ["-y", "@vendgogh/mcp-server"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost/db"
      }
    },
    "analytics-db": {
      "command": "node",
      "args": ["./mcp-servers/analytics.js"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    }
  }
}
```

In this example:
- `vendgogh` (if listed in `.silverback-auth.json`) will be wrapped with auth
- `analytics-db` (if listed in `.silverback-auth.json`) will be wrapped with auth
- `filesystem` will pass through unchanged (it's not in `.silverback-auth.json`)

### Example `.claude/settings.json`

```json
{
  "mcpServers": {
    "vendgogh": {
      "command": "npx",
      "args": ["-y", "@vendgogh/mcp-server"]
    }
  }
}
```

## Step 3: Set Environment Variables

Configure the proxy with required secrets and settings:

```bash
export MCP_JWT_SECRET="your-hmac-secret-here"
export MCP_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Security note:** Never commit secrets to version control. Use your deployment platform's secret management (GitHub Secrets, AWS Secrets Manager, etc.).

## Step 4: Runtime Behavior

When a workspace is initialized with these configurations, the following happens automatically:

1. **Configuration discovery**: The proxy loader reads `.silverback-auth.json` from the repo root
2. **Server discovery**: Merges MCP servers from `.mcp.json` and `.claude/settings.json`
3. **Config wrapping**: For each server listed in `.silverback-auth.json`:
   - Creates a proxy config file at `.claude/mcp-auth/{server-name}.json`
   - This file contains the original server's command, args, and env
4. **Server wrapping**: Replaces the server entry with the auth proxy:
   - `command`: `node`
   - `args`: `["/path/to/silverback-auth", "--config", ".claude/mcp-auth/{server-name}.json"]`
   - `env`: Sets `MCP_JWT_SECRET` and `MCP_TOKEN`
5. **Settings output**: Writes the complete wrapped config to `.claude/settings.local.json`

### Secrets Protection

The proxy automatically **strips secrets from the child process environment**:

```typescript
// These variables are NEVER passed to the MCP server
delete env['MCP_JWT_SECRET'];
delete env['MCP_TOKEN'];
```

This prevents credentials from leaking to untrusted MCP servers while still allowing the proxy to validate tokens.

### File Structure

```
repo/
├── .silverback-auth.json          # Which servers to wrap (committed)
├── .mcp.json                       # MCP server definitions (committed)
├── .claude/
│   ├── settings.json               # Claude settings (committed)
│   ├── settings.local.json         # Generated at runtime (gitignored)
│   └── mcp-auth/                   # Generated proxy configs (gitignored)
│       ├── vendgogh.json
│       └── analytics-db.json
└── <child process>                 # Actual MCP servers run here
```

## Step 5: Generating Tokens

### Via Slack Command

Generate tokens using the `/sb-mcp-token` command:

```
/sb-mcp-token <env> <tools> [ttl_hours]
```

**Parameters:**
- `env` — Target environment (e.g., `dev`, `prod`, `staging`)
- `tools` — Comma-separated tool patterns (e.g., `list_*,get_*`)
- `ttl_hours` — Token lifetime in hours (default: 4, max: 8)

**Examples:**

```
/sb-mcp-token dev list_*,get_* 4
```
Read-only access to `list_*` and `get_*` tools for 4 hours.

```
/sb-mcp-token prod * 1
```
Full tool access for 1 hour in production (use sparingly).

```
/sb-mcp-token dev raw_sql_query,list_tables
```
Specific tools with default 4-hour TTL.

**Result:**
The command returns an ephemeral Slack message (visible only to you) with:
- Your Slack user ID (subject)
- Target environment
- Allowed tool patterns
- Expiration timestamp
- The JWT token itself

### Programmatically

Generate tokens in code:

```typescript
import { generateToken } from './mcp-auth/token';

const token = generateToken(
  process.env.MCP_JWT_SECRET!,  // HMAC-SHA256 secret
  'U12345',                      // subject (who — usually Slack user ID)
  'dev',                         // environment
  ['list_*', 'get_*'],          // tool patterns
  4 * 3600                       // TTL in seconds (4 hours)
);

// token is a signed JWT string, e.g.:
// "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJVMTIzNDUiLCJlbnYiOiJkZXYiLCJ0b29scyI6WyJsaXN0XyoiLCJnZXRfKiJdLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDAxNDQwMH0...."
```

### Token Requirements

- **Max TTL**: 8 hours (28,800 seconds) — enforced at both generation and validation
- **Required claims**: `sub`, `env`, `tools`, `iat`, `exp`
- **Default-deny**: Tokens must explicitly list which tools are allowed. An empty `tools` array is rejected.
- **Algorithm**: HMAC-SHA256 (HS256)

## Tool Pattern Matching

Patterns in the JWT `tools` claim use simple glob matching:

| Pattern | Matches | Example |
|---------|---------|---------|
| `*` | All tools | Everything |
| `list_*` | Prefix match | `list_tables`, `list_schemas`, `list_users` |
| `get_*` | Prefix match | `get_user`, `get_config`, `get_status` |
| `raw_sql_query` | Exact match only | Only `raw_sql_query` |
| `describe_*` | Prefix match | `describe_table`, `describe_schema` |

**Combining patterns:**

```
["list_*", "get_*", "raw_sql_query"]
```

This allows:
- All tools starting with `list_` (e.g., `list_tables`, `list_schemas`)
- All tools starting with `get_` (e.g., `get_user`, `get_config`)
- The exact tool `raw_sql_query`

**How matching works:**
1. The proxy receives a `tools/call` request for a tool (e.g., `describe_table`)
2. It checks if `describe_table` matches ANY pattern in the token's `tools` array
3. If no pattern matches, the request is blocked with error code `-32003`

## JWT Token Structure

Tokens are standard JWT (JSON Web Tokens) with the following structure:

**Header:**
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

**Payload:**
```json
{
  "sub": "U12345",
  "env": "dev",
  "tools": ["list_*", "get_*"],
  "iat": 1700000000,
  "exp": 1700014400
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sub` | string | Yes | Subject (usually Slack user ID) |
| `env` | string | Yes | Target environment (e.g., `dev`, `prod`) |
| `tools` | string[] | Yes | Array of tool patterns (glob format) |
| `iat` | number | Yes | Issued at (Unix timestamp) |
| `exp` | number | Yes | Expires at (Unix timestamp) |

**Signature:**
```
HMAC-SHA256(base64(header) + "." + base64(payload), MCP_JWT_SECRET)
```

The complete token is: `header.payload.signature` (3 parts separated by dots).

## Error Handling

### Error Codes

When the proxy rejects a request, it returns a JSON-RPC error response:

| Code | Meaning | When |
|------|---------|------|
| `-32003` | Insufficient scope | `tools/call` for a tool not in the token's `tools` patterns |
| `-32700` | Parse error | Malformed JSON-RPC message from client |

### Example: Blocked Tool Call

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "raw_sql_query",
    "arguments": {"sql": "DELETE FROM users WHERE id = 1"}
  }
}
```

**Response (if `raw_sql_query` is not in the token):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32003,
    "message": "tool not permitted: raw_sql_query"
  }
}
```

### Example: Hidden Tool in List Response

When the client calls `tools/list`:

**Original response from MCP server:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {"name": "list_tables", "description": "List tables"},
      {"name": "list_schemas", "description": "List schemas"},
      {"name": "raw_sql_query", "description": "Execute SQL"}
    ]
  }
}
```

**Filtered response (if only `list_*` is allowed):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {"name": "list_tables", "description": "List tables"},
      {"name": "list_schemas", "description": "List schemas"}
    ]
  }
}
```

The `raw_sql_query` tool is hidden from the LLM entirely — it won't appear in the tool list.

## Example: Restricting a Database Server

### Goal
Allow a user to list tables and schemas, but prevent them from running arbitrary SQL queries.

### Step 1: Register the server for auth (`.silverback-auth.json`)

```json
{
  "servers": ["database"]
}
```

### Step 2: Define the server (`.mcp.json`)

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["./mcp-servers/database.js"],
      "env": {
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}
```

### Step 3: Set environment variables

```bash
export MCP_JWT_SECRET="secret-key-here"
```

### Step 4: Generate a restricted token

```
/sb-mcp-token dev list_tables,list_schemas,describe_table 4
```

### Result

The user can now:
- Call `list_tables` — returns table list
- Call `list_schemas` — returns schema list
- Call `describe_table` — returns table details

But calling `raw_sql_query` returns:

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "error": {
    "code": -32003,
    "message": "tool not permitted: raw_sql_query"
  }
}
```

And `tools/list` response only includes the 3 allowed tools — `raw_sql_query` is completely hidden from the LLM.

## Security Considerations

### Secret Management

- **Never commit `MCP_JWT_SECRET` to version control**
- Use your deployment platform's secret management:
  - GitHub Secrets (for Actions)
  - AWS Secrets Manager (for Lambda)
  - HashiCorp Vault (for self-hosted)
  - Environment variable injection at deployment time

### Default-Deny Policy

Tokens must explicitly list which tools are allowed:
- An empty `tools` array is rejected (validation fails)
- A token without the `tools` claim is rejected
- If a token doesn't list a tool, that tool is blocked

### Secrets Never Leak

The proxy automatically removes authentication secrets from child process environments:
- `MCP_JWT_SECRET` is stripped before spawning the MCP server
- `MCP_TOKEN` is stripped before spawning the MCP server
- This prevents untrusted MCP servers from accessing authentication tokens

### Short-Lived Tokens

- **Max TTL: 8 hours** — enforced at both generation and validation
- **Default TTL: 4 hours** (via `/sb-mcp-token`)
- Tokens are typically generated on-demand via Slack commands, not stored long-term
- Expired tokens are rejected with a clear error message

### Ephemeral Token Delivery

- Slack command results are posted as ephemeral messages
- Only the requesting user can see the token message
- Tokens are not logged or stored in shared channels
- Users should treat tokens like passwords — keep them private

### Credential Management for MCP Servers

The proxy does NOT manage credentials for MCP servers themselves. This remains the MCP server's responsibility:

- Database credentials → Vault, environment variables, or IAM roles
- API keys → Secrets management system
- SSH keys → SSH agent or key files
- OAuth tokens → Refresh token flow

The proxy only controls **which MCP tools are accessible**, not how those tools authenticate to external systems.

## Proxy Lifecycle

### Startup

```
1. Proxy reads --config flag and loads server config from JSON file
2. Checks if MCP_JWT_SECRET is set
3. If set: validates MCP_TOKEN, extracts tool patterns and environment
4. If not set: enters bypass mode (transparent pass-through)
5. Spawns child MCP server process
6. Removes MCP_JWT_SECRET and MCP_TOKEN from child environment
7. Starts bidirectional JSON-RPC forwarding
```

### Request Flow (Authenticated)

```
Client                    Proxy                  MCP Server
  │                        │                         │
  ├─ tools/call request ──→│                         │
  │                        ├─ Check tool pattern    │
  │                        │  allowed?               │
  │                        │  (YES)                  │
  │                        ├─ Forward to server ────→│
  │                        │                         ├─ Process request
  │                        │←─ Response ────────────│
  │←─ Response ───────────│                         │
  │                        │                         │
  ├─ tools/call request ──→│                         │
  │   (unauthorized)       ├─ Check tool pattern    │
  │                        │  allowed?               │
  │                        │  (NO)                   │
  │←─ Error -32003 ───────┤                         │
  │   (not forwarded)      │                         │
```

### Shutdown

```
1. Client closes connection
2. Proxy signals EOF to child process
3. Proxy sends SIGTERM to child
4. Proxy waits up to 5 seconds for clean exit
5. If child doesn't exit, proxy sends SIGKILL
6. Proxy exits with child's exit code
```

## Logging

The proxy logs important events to stderr using structured logging:

```
[silverback-auth] info: bypass mode: no authentication
[silverback-auth:proxy] info: denied tools/call: raw_sql_query
[silverback-auth:child] info: spawning child: node ./mcp-servers/database.js
[silverback-auth:child] info: child exited with code 0
```

**Log levels:**
- `error` — Fatal errors (invalid config, token validation failure, process errors)
- `warn` — Non-fatal issues (wildcard tool access, malformed messages)
- `info` — Normal operations (mode, token validation, tool denials)

## Testing and Verification

### Test Token Generation

```typescript
import { generateToken, validateToken } from './mcp-auth/token';

const secret = 'test-secret';
const token = generateToken(secret, 'U123', 'dev', ['list_*'], 3600);
const claims = validateToken(token, secret);

console.log(claims);
// {
//   sub: 'U123',
//   env: 'dev',
//   tools: ['list_*'],
//   iat: 1700000000,
//   exp: 1700003600
// }
```

### Test Tool Matching

```typescript
import { isToolAllowed, matchToolPattern } from './mcp-auth/token';

// Pattern matching
matchToolPattern('list_*', 'list_tables');        // true
matchToolPattern('list_*', 'get_config');         // false
matchToolPattern('*', 'anything');                 // true
matchToolPattern('exact_name', 'exact_name');     // true

// Token-based matching
isToolAllowed('list_tables', ['list_*', 'get_*']);     // true
isToolAllowed('raw_sql_query', ['list_*', 'get_*']);   // false
isToolAllowed('raw_sql_query', ['*']);                 // true
```

### Test Proxy Behavior

1. **Start with auth disabled** (bypass mode):
   ```bash
   node ./dist/mcp-auth/index.js --config test-config.json
   ```
   All JSON-RPC messages pass through.

2. **Set token and secret**:
   ```bash
   export MCP_JWT_SECRET="test-secret"
   export MCP_TOKEN="<valid-token>"
   node ./dist/mcp-auth/index.js --config test-config.json
   ```
   Only authorized tools work.

3. **Send invalid token**:
   Proxy exits with error: `token validation failed: ...`

4. **Send expired token**:
   Proxy exits with error: `token validation failed: token expired`

## Troubleshooting

### "MCP_JWT_SECRET is set but MCP_TOKEN is missing"

**Cause:** `MCP_JWT_SECRET` is set in the environment, but `MCP_TOKEN` is not.

**Fix:** Generate and set a valid token:
```bash
export MCP_TOKEN="<generated-token>"
```

Or, to disable auth, unset the secret:
```bash
unset MCP_JWT_SECRET
```

### "token validation failed: token invalid"

**Cause:** Token is malformed, signed with wrong secret, or corrupted.

**Fix:**
1. Verify the token string is complete and uncorrupted
2. Verify `MCP_JWT_SECRET` matches the secret used to generate the token
3. Generate a new token with the correct secret

### "token validation failed: token expired"

**Cause:** Token's `exp` timestamp is in the past.

**Fix:** Generate a new token with a future expiration time.

### "tool not permitted: raw_sql_query"

**Cause:** Token doesn't include `raw_sql_query` in the `tools` patterns.

**This is expected behavior.** The proxy is correctly blocking an unauthorized tool.

**Fix:** Generate a new token that includes the tool pattern:
```
/sb-mcp-token dev raw_sql_query,list_* 4
```

### MCP server child process exits immediately

**Cause:** Config file path is wrong, or child command doesn't exist.

**Fix:**
1. Check that `.claude/mcp-auth/{server-name}.json` exists
2. Check that the `command` and `args` in the config point to a valid MCP server
3. Test the child command manually: `node ./mcp-servers/database.js`

### Proxy hangs on shutdown

**Cause:** Child MCP server ignores SIGTERM and doesn't exit gracefully.

**Fix:** Proxy has a 5-second timeout and will send SIGKILL. If the server still doesn't exit:
1. Ensure the MCP server handles SIGTERM properly
2. Add a timeout in the server's signal handler

## References

- **JWT Specification:** [RFC 7519](https://tools.ietf.org/html/rfc7519)
- **JSON-RPC 2.0:** [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- **Model Context Protocol:** [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
