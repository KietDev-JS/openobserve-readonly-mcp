# Setup

A step-by-step guide to connecting `openobserve-readonly-mcp` to an AI client.

The order matters: verify connectivity from a terminal **before** editing any
MCP config. MCP servers communicate over stdin/stdout, so a misconfigured one
usually fails silently — the tools simply never appear, with no error to read.

## 1. Prerequisites

- Node.js 18.17 or newer (`node --version`)
- An OpenObserve instance you can reach
- Credentials for a user on that instance

## 2. Create a read-only user

This server refuses to call anything but three read endpoints, but it cannot
reduce the privileges of the credential you hand it. If the token can delete a
stream, that power still exists — it is simply unused here. A misconfigured
client, or a future change, should not be able to reach it.

In OpenObserve: **Management → Users → Add User**, and assign a viewer or
read-only role. Use that account below.

## 3. Build the auth value

`O2_AUTH` is an HTTP Authorization header value.

macOS / Linux:

```bash
printf 'you@example.com:YOUR_PASSWORD' | base64
```

Windows PowerShell:

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('you@example.com:YOUR_PASSWORD'))
```

The result is used as `Basic <that string>`.

## 4. Verify connectivity first

Confirm the URL, org and credential work before involving an AI client:

```bash
curl -s -H "Authorization: Basic BASE64_HERE" \
  https://openobserve.example.com/api/default/streams | head -c 300
```

Expect a JSON object containing `"list"`.

- `401` → wrong credential. Re-check the base64 (no trailing newline).
- `404` → wrong org. The path segment after `/api/` is your `O2_ORG`.
- Connection refused → wrong host or port.

If OpenObserve is behind a reverse proxy at a subpath, include it in the base
URL (`https://host/observe`); the server preserves the mount path.

## 5. Check the server starts

```bash
O2_BASE_URL="https://openobserve.example.com" \
O2_AUTH="Basic BASE64_HERE" \
npx -y openobserve-readonly-mcp
```

A correctly configured server **prints nothing and waits** — it is listening
for JSON-RPC on stdin. That silence is success. Press Ctrl+C.

If configuration is missing or malformed, it exits immediately with status 2
and a message naming the variable at fault.

To confirm it actually responds, pipe one request in:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  O2_BASE_URL="https://openobserve.example.com" \
  O2_AUTH="Basic BASE64_HERE" \
  npx -y openobserve-readonly-mcp
```

You should get one line of JSON listing three tools.

## 6. Configure your client

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "openobserve": {
      "command": "npx",
      "args": ["-y", "openobserve-readonly-mcp"],
      "env": {
        "O2_BASE_URL": "https://openobserve.example.com",
        "O2_AUTH": "Basic BASE64_HERE"
      }
    }
  }
}
```

Restart Claude Desktop completely — quit the application, do not just close
the window.

### Claude Code

Add the same block to `mcpServers` in `~/.claude.json`, with `"type": "stdio"`.

### opencode

Add to `opencode.json` under `mcp`:

```json
{
  "mcp": {
    "openobserve": {
      "type": "local",
      "command": ["npx", "-y", "openobserve-readonly-mcp"],
      "enabled": true,
      "environment": {
        "O2_BASE_URL": "https://openobserve.example.com",
        "O2_AUTH": "Basic BASE64_HERE"
      }
    }
  }
}
```

### Running from a clone

Replace the command with the absolute path to the entry point:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/openobserve-readonly-mcp/bin/openobserve-readonly-mcp.mjs"]
}
```

## 7. Confirm it is connected

Ask the assistant to list your OpenObserve streams. It should call
`o2_list_streams` and return names with document counts.

A good first real query:

```
Show me ERROR level entries from the last hour in the app_logs stream
```

## Troubleshooting

**Tools do not appear.** Almost always the client cannot start the process.
Check the client's MCP log, confirm `npx` is on `PATH` for the client (GUI
apps do not always inherit your shell `PATH` — use an absolute `node` path if
needed), and verify the JSON config parses.

**"O2_BASE_URL is not set" although it is set in your shell.** GUI clients do
not inherit your shell environment. Put the variables in the `env` block of
the MCP config, not in `.bashrc` or `.zshrc`.

**401 from a working curl command.** The base64 likely contains a trailing
newline. Use `printf`, not `echo`.

**"time window exceeds 1440 minutes".** Narrow the range, or raise
`O2_MAX_WINDOW_MIN`. The cap exists because wide windows are expensive
upstream.

**"Schema error: No field named X".** Call `o2_stream_schema` first; field
names vary per stream.

**Results come back `truncated`.** The response exceeded 60 KB and rows were
shed. Select fewer columns, lower `size`, or narrow the window. The
`truncated` object reports how many rows of the match set you actually got.

**Enable debug output.** Set `O2_DEBUG=1` to print the resolved configuration
(credential redacted) to stderr at startup.
