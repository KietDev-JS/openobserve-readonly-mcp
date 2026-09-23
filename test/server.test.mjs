import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { makeClient, reply, streamList } from './helpers.mjs';
import { createServer, listen, SUPPORTED_PROTOCOLS, SERVER_INFO } from '../src/server.mjs';
import { TOOLS } from '../src/tools.mjs';

/** Collect every message a handler emits for the given inputs. */
function harness(responder) {
  const { client, calls } = makeClient(responder);
  const sent = [];
  const handle = createServer(client, (m) => sent.push(m));
  return { handle, sent, calls };
}

describe('initialize', () => {
  test('echoes a protocol version it supports', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(sent[0].result.protocolVersion, '2025-06-18');
  });

  test('falls back to the newest version for an unknown request', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(sent[0].result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
  });

  test('advertises tools capability and server info', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 1, method: 'initialize', params: {} });
    assert.deepEqual(sent[0].result.capabilities, { tools: {} });
    assert.equal(sent[0].result.serverInfo.name, SERVER_INFO.name);
  });
});

describe('protocol basics', () => {
  test('ping returns an empty result', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 2, method: 'ping' });
    assert.deepEqual(sent[0].result, {});
  });

  test('tools/list returns all tools', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 3, method: 'tools/list' });
    assert.equal(sent[0].result.tools.length, TOOLS.length);
  });

  test('unknown method returns -32601', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 4, method: 'resources/list' });
    assert.equal(sent[0].error.code, -32601);
  });

  test('notifications are never answered', async () => {
    const { handle, sent } = harness({});
    await handle({ method: 'notifications/initialized' });
    await handle({ method: 'notifications/cancelled' });
    // An unknown *notification* must also stay silent.
    await handle({ method: 'totally/unknown' });
    assert.equal(sent.length, 0);
  });

  test('a null id is treated as a notification', async () => {
    const { handle, sent } = harness({});
    await handle({ id: null, method: 'unknown/method' });
    assert.equal(sent.length, 0);
  });
});

describe('tools/call', () => {
  test('returns JSON text content on success', async () => {
    const { handle, sent } = harness(streamList(3));
    await handle({ id: 5, method: 'tools/call', params: { name: 'o2_list_streams', arguments: {} } });
    const payload = JSON.parse(sent[0].result.content[0].text);
    assert.equal(payload.matched, 3);
    assert.ok(!sent[0].result.isError);
  });

  test('reports an unknown tool as a tool error, not a protocol error', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    assert.equal(sent[0].result.isError, true);
    assert.match(sent[0].result.content[0].text, /Unknown tool/);
  });

  test('handles a call with no params', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 7, method: 'tools/call' });
    assert.equal(sent[0].result.isError, true);
  });

  test('surfaces validation failures as readable tool errors', async () => {
    const { handle, sent } = harness({});
    await handle({ id: 8, method: 'tools/call', params: { name: 'o2_search', arguments: { sql: 'DROP TABLE x' } } });
    assert.equal(sent[0].result.isError, true);
    assert.match(sent[0].result.content[0].text, /only SELECT \/ WITH/);
  });

  test('surfaces upstream failures as tool errors', async () => {
    const { handle, sent } = harness(reply({ status: 401, text: 'nope' }));
    await handle({ id: 9, method: 'tools/call', params: { name: 'o2_list_streams', arguments: {} } });
    assert.equal(sent[0].result.isError, true);
    assert.match(sent[0].result.content[0].text, /401/);
  });

  test('never leaks the credential in an error', async () => {
    const { handle, sent } = harness(reply({ status: 403, text: 'denied' }));
    await handle({ id: 10, method: 'tools/call', params: { name: 'o2_list_streams', arguments: {} } });
    assert.ok(!JSON.stringify(sent[0]).includes('ZHVtbXk'));
  });

  test('bounds oversized results and still returns valid JSON', async () => {
    const { handle, sent } = harness(streamList(5000));
    await handle({ id: 11, method: 'tools/call', params: { name: 'o2_list_streams', arguments: { limit: 500 } } });
    const text = sent[0].result.content[0].text;
    assert.ok(text.length <= 60_000);
    assert.doesNotThrow(() => JSON.parse(text));
  });
});

describe('stdio framing', () => {
  const drive = async (lines) => {
    const input = new PassThrough();
    const out = [];
    const output = { write: (s) => out.push(s) };
    const { client } = makeClient({});
    const ref = {};
    listen((m) => ref.handle(m), { input, output });
    ref.handle = createServer(client, (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`));
    for (const l of lines) input.write(`${l}\n`);
    input.end();
    await new Promise((r) => setTimeout(r, 60));
    return out;
  };

  test('emits one newline-delimited JSON object per request', async () => {
    const out = await drive([JSON.stringify({ id: 1, method: 'ping' }), JSON.stringify({ id: 2, method: 'ping' })]);
    assert.equal(out.length, 2);
    for (const line of out) {
      assert.ok(line.endsWith('\n'));
      assert.equal(JSON.parse(line).jsonrpc, '2.0');
    }
  });

  test('returns -32700 for malformed JSON', async () => {
    const out = await drive(['{ not json }']);
    assert.equal(JSON.parse(out[0]).error.code, -32700);
  });

  test('ignores blank lines', async () => {
    const out = await drive(['', '   ', JSON.stringify({ id: 1, method: 'ping' })]);
    assert.equal(out.length, 1);
  });

  test('keeps serving after a parse error', async () => {
    const out = await drive(['{bad}', JSON.stringify({ id: 9, method: 'ping' })]);
    assert.equal(out.length, 2);
    assert.equal(JSON.parse(out[1]).id, 9);
  });
});
