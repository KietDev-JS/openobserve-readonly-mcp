# openobserve-readonly-mcp

[![CI](https://github.com/KietDev-JS/openobserve-readonly-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KietDev-JS/openobserve-readonly-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openobserve-readonly-mcp)](https://www.npmjs.com/package/openobserve-readonly-mcp)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A read-only [MCP](https://modelcontextprotocol.io) server for
[OpenObserve](https://openobserve.ai). It lets an AI assistant list streams,
inspect schemas, and run bounded SQL searches over your logs, metrics and
traces — without the ability to write anything.

Zero runtime dependencies; it uses only the Node standard library.

## Why read-only matters here

Giving a model log search is useful. Giving it an observability API token is a
different proposition: the same credential that reads logs can often delete
streams, change retention, or edit alerts.

This server narrows that surface in-process:

- **Three endpoints, allowlisted.** Every outbound request is matched against
  an allowlist before it is sent. The only `POST` is `/_search`. Anything else
  — including a request the model constructs itself — is refused locally.
- **SELECT/WITH only.** SQL is parsed for structure before it leaves the
  process: no stacked statements, no comments, no DDL/DML keywords outside
  string literals.
- **Bounded output.** Row counts, string sizes, the time window, and the total
  response size are all capped, so one careless query cannot flood the context
  window or the upstream server.

**This does not reduce the privileges of the credential you supply.** The
allowlist constrains this process, not your token. For an actual guarantee,
create a read-only OpenObserve user and put *that* in `O2_AUTH`. The two
layers are complementary: the token bounds what is possible, this server
bounds what is attempted.

## Tools

| Tool | Purpose |
| --- | --- |
| `o2_list_streams` | List streams with type, document count, last event time. Supports substring and type filters. |
| `o2_stream_schema` | Field names and types for one stream. Use it before writing a query. |
| `o2_search` | Run one `SELECT`/`WITH` query over a bounded time window. |

All three are annotated `readOnlyHint: true`.

## Install

Requires Node.js 18.17 or newer.

```bash
npx openobserve-readonly-mcp
```

Or install globally:

```bash
npm install -g openobserve-readonly-mcp
```

Or from source:

```bash
git clone https://github.com/KietDev-JS/openobserve-readonly-mcp.git
cd openobserve-readonly-mcp
npm test
```

## Configuration

Configuration is environment-only. There is no default host: the server exits
with status 2 and an explanatory message rather than guessing where to send
your credentials.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `O2_BASE_URL` | yes | — | e.g. `https://openobserve.example.com`. A reverse-proxy subpath such as `https://host/observe` is supported. |
| `O2_AUTH` | yes | — | `Basic <base64 of email:password>` or `Bearer <token>`. |
| `O2_ORG` | no | `default` | OpenObserve organization identifier. |
| `O2_MAX_WINDOW_MIN` | no | `1440` | Largest allowed search window, in minutes. |
| `O2_TIMEOUT_MS` | no | `60000` | Upstream request timeout. |
| `O2_DEBUG` | no | — | Log the resolved config (credential redacted) to stderr. |

Generate the Basic value with:

```bash
printf 'you@example.com:YOUR_PASSWORD' | base64
```

## Client setup

Claude Desktop (`claude_desktop_config.json`), Claude Code (`~/.claude.json`):

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

opencode (`opencode.json`):

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

See [docs/SETUP.md](docs/SETUP.md) for a step-by-step walkthrough, including a
connectivity check to run *before* touching any MCP config.

## Querying

Stream names must be double-quoted, and results are ordered by `_timestamp`
descending in practice:

```sql
SELECT _timestamp, level, message
FROM "app_logs"
WHERE level = 'ERROR'
ORDER BY _timestamp DESC
```

Useful details:

- `_timestamp` is **microseconds** since the epoch. Each returned row also
  carries an ISO-8601 `_time` field for readability.
- The window defaults to the last 15 minutes. Pass `minutes`, or an explicit
  `start`/`end` ISO-8601 pair.
- `size` defaults to 50 and is capped at 200 rows.
- Keywords inside string literals are fine: searching for the text
  `'delete'` is not mistaken for a `DELETE` statement.

## Limits

| Limit | Value | Why |
| --- | --- | --- |
| Rows per search | 200 | Keeps a single call from flooding the context window. |
| Streams per listing | 500 | Same. |
| String cell length | 500 chars | Clipped at any nesting depth; long stack traces are the usual culprit. |
| Response size | 60 KB | Rows are shed progressively; output is always valid JSON. |
| Time window | 1440 min | Bounds upstream query cost. Raise with `O2_MAX_WINDOW_MIN`. |

When a result is reduced, the response includes a `truncated` object recording
how many rows were returned out of how many matched — the reduction is
reported rather than silent.

## Security notes

- The credential is never echoed in error messages or logs; `O2_DEBUG` output
  redacts it.
- Stream names are validated against `^[A-Za-z0-9_][A-Za-z0-9_.-]*$`, and any
  request whose path changes under URL normalization is refused, so traversal
  attempts cannot escape the allowlisted routes.
- Prefer passing `O2_AUTH` through your MCP client's `env` block over exporting
  it into your shell profile.

## Development

```bash
npm test              # 141 tests, no network access required
npm run test:coverage # ~98% line coverage
```

The suite injects a fake `fetch`, so it runs fully offline and deterministically.

## License

MIT
