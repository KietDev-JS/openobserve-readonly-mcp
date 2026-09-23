// MCP stdio server: JSON-RPC 2.0 framing over newline-delimited stdin/stdout.

import { createInterface } from 'node:readline';
import { TOOLS, createHandlers, ToolError } from './tools.mjs';
import { serializeBounded } from './sanitize.mjs';
import { SqlError } from './sql.mjs';
import { O2Error } from './client.mjs';

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INFO = { name: 'openobserve-readonly-mcp', version: '1.0.0' };

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
    const impl = handlers[name];
    if (!impl) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    try {
      const result = await impl(params.arguments || {});
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
  const send = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
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
