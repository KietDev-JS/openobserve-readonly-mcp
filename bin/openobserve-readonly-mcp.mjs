#!/usr/bin/env node
// Entry point: load config, build the client, serve MCP over stdio.

import { loadConfig, ConfigError, redact } from '../src/config.mjs';
import { O2Client } from '../src/client.mjs';
import { createServer, listen, SERVER_INFO } from '../src/server.mjs';

const HELP = `${SERVER_INFO.name} ${SERVER_INFO.version}

A read-only MCP stdio server for OpenObserve. Configure with environment variables:

  O2_BASE_URL        required, e.g. https://openobserve.example.com
  O2_AUTH            required, "Basic <base64 email:password>" or "Bearer <token>"
  O2_ORG             organization (default: default)
  O2_MAX_WINDOW_MIN  largest search window in minutes (default: 1440)
  O2_TIMEOUT_MS      upstream request timeout (default: 60000)
  O2_DEBUG           log resolved config to stderr, credential redacted
`;

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`openobserve-readonly-mcp: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  if (process.env.O2_DEBUG) {
    process.stderr.write(`openobserve-readonly-mcp config: ${JSON.stringify(redact(config))}\n`);
  }

  const client = new O2Client(config);
  const handlerRef = { current: null };
  const { send } = listen((msg) => handlerRef.current(msg));
  handlerRef.current = createServer(client, send);
}

main();
