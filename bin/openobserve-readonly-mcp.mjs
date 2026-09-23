#!/usr/bin/env node
// Entry point: load config, build the client, serve MCP over stdio.

import { loadConfig, ConfigError, redact } from '../src/config.mjs';
import { O2Client } from '../src/client.mjs';
import { createServer, listen } from '../src/server.mjs';

function main() {
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
