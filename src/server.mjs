// MCP stdio server: JSON-RPC 2.0 framing over newline-delimited stdin/stdout.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { TOOLS, createHandlers, ToolError } from './tools.mjs';
import { serializeBounded } from './sanitize.mjs';
import { SqlError } from './sql.mjs';
import { O2Error } from './client.mjs';

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Read the version from package.json so serverInfo and --version cannot drift
// from the published package. npm always ships package.json.
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const SERVER_INFO = { name: PKG.name, version: PKG.version };

const ALLOWED_ARGS = new Map(TOOLS.map((t) => [t.name, new Set(Object.keys(t.inputSchema.properties))]));

/**
 * Enforce the shape every tool schema declares: an object with no unknown keys.
 *
 * Schemas say `additionalProperties: false`, but clients are not required to
 * validate. Without this a misspelled argument (`limt`, `minute`) is silently
 * dropped and the call runs with defaults, which looks like a wrong answer
 * rather than a mistake the model can fix.
 */
export function checkArguments(name, args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError(`arguments must be a JSON object, got ${Array.isArray(args) ? 'array' : typeof args}`);
  }
  const allowed = ALLOWED_ARGS.get(name);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const expected = [...allowed].join(', ') || '(none)';
    throw new ToolError(`unknown argument(s) for ${name}: ${unknown.join(', ')}. Expected: ${expected}`);
  }
  return args;
}

/**
 * Create a message handler.
 *
 * @param {import('./client.mjs').O2Client} client
 * @param {(msg: object) => void} send
 */
export function createServer(client, send) {
  const handlers = createHandlers(client);

  async function callTool(params) {
    const name = params?.name;
    const impl = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!impl) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    try {
      const result = await impl(checkArguments(name, params.arguments));
      return { content: [{ type: 'text', text: serializeBounded(result) }] };
    } catch (e) {
      // Validation and upstream failures are tool-level results, not protocol
      // errors: the model should see them and can correct its next call.
      const expected = e instanceof ToolError || e instanceof SqlError || e instanceof O2Error;
      const text = expected ? e.message : `Unexpected error: ${e?.message || e}`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
  }

  return async function handle(msg) {
    const { id, method, params } = msg ?? {};
    const isRequest = id !== undefined && id !== null;

    try {
      switch (method) {
        case 'initialize': {
          const want = params?.protocolVersion;
          return send({
            id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
            },
          });
        }
        case 'ping':
          return send({ id, result: {} });
        case 'tools/list':
          return send({ id, result: { tools: TOOLS } });
        case 'tools/call':
          return send({ id, result: await callTool(params) });
        default:
          // Notifications (no id) are never answered, per JSON-RPC.
          if (isRequest) {
            send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
          }
      }
    } catch (e) {
      if (isRequest) {
        send({ id, error: { code: -32603, message: String(e?.message || e) } });
      }
    }
  };
}

/**
 * Wire a handler to stdin/stdout.
 */
export function listen(handle, { input = process.stdin, output = process.stdout } = {}) {
  let closed = false;
  // A client that exits mid-call closes our stdout; writing to it then emits
  // EPIPE as an unhandled 'error' event and crashes with a stack trace.
  output.on?.('error', () => {
    closed = true;
  });
  const send = (m) => {
    if (closed || output.destroyed) return;
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  };
  const rl = createInterface({ input });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    // Errors are handled inside; keep the reader alive regardless.
    Promise.resolve(handle(msg)).catch(() => {});
  });

  return { send, close: () => rl.close() };
}
