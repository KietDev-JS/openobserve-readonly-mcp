// Shared test helpers: a fake fetch so the suite runs fully offline.

import { loadConfig } from '../src/config.mjs';
import { O2Client } from '../src/client.mjs';
import { createHandlers } from '../src/tools.mjs';

export const TEST_ENV = {
  O2_BASE_URL: 'https://o2.example.com',
  O2_AUTH: 'Basic ZHVtbXk6ZHVtbXk=',
};

/**
 * Marker for a raw HTTP response, as opposed to a plain JSON body.
 *
 * Without this, a fixture like `{ status: 401, text: 'nope' }` is
 * indistinguishable from a JSON body that happens to have those keys, and the
 * fake would silently return it as a 200.
 *
 * @param {{ status?: number, text?: string, body?: unknown }} spec
 */
export function reply(spec) {
  return { __httpResponse: true, ...spec };
}

/**
 * Build a client whose fetch returns canned responses and records calls.
 *
 * @param {object|((url: URL, init: object) => object)} responder
 *   A plain JSON body, a `reply(...)` response, an Error to throw, or a
 *   function returning any of those.
 */
export function makeClient(responder, env = TEST_ENV) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body });
    const raw = typeof responder === 'function' ? responder(new URL(url), init) : responder;
    if (raw instanceof Error) throw raw;
    const r = raw && raw.__httpResponse ? raw : { body: raw };
    const text = r.text !== undefined ? r.text : JSON.stringify(r.body ?? {});
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      text: async () => {
        // Simulates a failure while the body is streaming (timeout, reset).
        if (r.textError) throw r.textError;
        return text;
      },
    };
  };
  const client = new O2Client(loadConfig(env), { fetch: fetchImpl });
  return { client, calls, handlers: createHandlers(client) };
}

/** A stream list fixture of the requested size. */
export function streamList(n, prefix = 'stream') {
  return {
    list: Array.from({ length: n }, (_, i) => ({
      name: `${prefix}_${i}`,
      stream_type: i % 3 === 0 ? 'metrics' : 'logs',
      stats: { doc_num: i * 10, doc_time_max: 1_700_000_000_000_000 },
    })),
  };
}
